import test from "node:test";
import assert from "node:assert/strict";

import {
	addExistingBranchItem,
	clearFailure,
	createPiHarness,
	setFailure,
	setOpenPullRequest,
} from "./helpers.mjs";

test("pi creates a Planning item on the first substantive prompt and ignores lightweight follow-ups", async () => {
	const harness = await createPiHarness("planning-prompt");

	await harness.runPrompt("plan the oauth callback recovery flow");

	const state = harness.readPiState();
	const ghState = harness.readGhState();
	assert.equal(state.mode, "aligned");
	assert.equal(state.statusKey, "planning");
	assert.equal(ghState.project.items.length, 1);

	await harness.runPrompt("ok");
	assert.equal(harness.readGhState().project.items.length, 1);
});

test("pi promotes to In Progress on first code change and comments Markdown planning artifacts", async () => {
	const harness = await createPiHarness("planning-artifacts");

	await harness.runPrompt("plan the alignment migration");
	await harness.runPrompt("also keep the github project fields backward compatible");
	harness.writeFile("PLAN.md", "# Migration plan\n\n- Keep legacy todo mapping\n");

	await harness.runPostTool("edit");

	const state = harness.readPiState();
	const ghState = harness.readGhState();
	const issue = ghState.repos[harness.repoFullName].issues[0];

	assert.equal(state.statusKey, "inProgress");
	assert.equal(issue.comments.length, 1);
	assert.match(issue.comments[0].body, /PLAN\.md/);
});

test("pi keeps open PR work In Progress until merge", async () => {
	const harness = await createPiHarness("open-pr");

	await harness.runPrompt("implement branch-based recovery");
	await harness.runPostTool("write");
	setOpenPullRequest(harness, "feature/test");

	await harness.runBashTool();

	assert.equal(harness.readPiState().statusKey, "inProgress");
	assert.equal(harness.readGhState().project.items[0].fieldValues.Status, "In Progress");
});

test("pi marks work Done when the feature branch head lands on default", async () => {
	const harness = await createPiHarness("merged-feature");

	await harness.runPrompt("ship the finish detection update");
	await harness.runPostTool("edit");

	harness.writeFile("src.js", "export const value = 1;\n");
	harness.git(["add", "src.js"]);
	harness.git(["commit", "-m", "Implement feature"]);
	harness.git(["checkout", "main"]);
	harness.git(["merge", "--no-ff", "feature/test", "-m", "Merge feature"]);
	harness.git(["push", "origin", "main"]);
	harness.git(["checkout", "feature/test"]);

	await harness.runBashTool();

	assert.equal(harness.readPiState().statusKey, "finished");
	assert.equal(harness.readGhState().project.items[0].fieldValues.Status, "Done");
});

test("pi relinks an existing branch item instead of creating a duplicate", async () => {
	const harness = await createPiHarness("branch-relink");
	const existing = addExistingBranchItem(harness, {
		title: "Existing branch work",
		branch: "feature/test",
		status: "Planning",
	});

	await harness.runPrompt("work on something that would otherwise create a duplicate");

	assert.equal(harness.readPiState().itemId, existing.item.id);
	assert.equal(harness.readGhState().project.items.length, 1);
});

test("pi supports manual finish and unlink commands", async () => {
	const harness = await createPiHarness("finish-and-unlink");

	await harness.runPrompt("implement unlink support for alignment sessions");
	await harness.runPostTool("edit");

	assert.equal(await harness.runPiCommand("align-finish"), "marked as done");
	assert.equal(harness.readPiState().statusKey, "finished");

	assert.equal(await harness.runPiCommand("align-unlink"), "alignment stopped");
	await harness.runPrompt("start a different task after unlink");
	assert.equal(harness.readPiState().mode, "unlinked");
});

test("pi auto-switches to a new task on a new branch without confirmation", async () => {
	const harness = await createPiHarness("task-switch");

	await harness.runPrompt("plan task one for the initial migration flow");

	harness.git(["checkout", "main"]);
	harness.git(["checkout", "-b", "feature/two"]);

	await harness.runPrompt("now implement a completely different task on the new branch");

	const state = harness.readPiState();
	assert.equal(harness.readGhState().project.items.length, 2);
	assert.equal(state.branch, "feature/two");
	assert.match(state.itemTitle, /completely different task/i);
});

test("pi resync recovers a missing project item using the original issue content id", async () => {
	const harness = await createPiHarness("resync-recovery");

	await harness.runPrompt("plan recovery for a missing project item on resync");
	const before = harness.readPiState();
	const ghState = harness.readGhState();
	ghState.project.items = [];
	harness.writeGhState(ghState);

	assert.equal(await harness.runPiCommand("align-resync"), "alignment recovered and synced");

	const after = harness.readPiState();
	assert.notEqual(after.itemId, before.itemId);
	assert.equal(after.contentId, before.contentId);
	assert.equal(harness.readGhState().project.items.length, 1);
});

test("pi records non-blocking failures and retries on later lifecycle events", async () => {
	const harness = await createPiHarness("failure-retry");

	setFailure(harness, "projectFetch", true);
	await harness.runPrompt("plan retry behavior after a project fetch failure");

	const failedState = harness.readPiState();
	assert.equal(failedState.mode, "pending");
	assert.match(failedState.lastError, /project .* not found/i);

	clearFailure(harness);
	await harness.runPostTool("edit");

	const recovered = harness.readPiState();
	assert.equal(recovered.statusKey, "inProgress");
	assert.equal(recovered.lastError, undefined);
});

test("pi falls back to a draft project item when issue creation fails", async () => {
	const harness = await createPiHarness("draft-fallback");

	setFailure(harness, "issueCreate", true);
	await harness.runPrompt("plan the draft fallback when issue creation fails");

	const state = harness.readPiState();
	const ghState = harness.readGhState();
	assert.equal(state.statusKey, "planning");
	assert.equal(ghState.project.items[0].contentType, "DraftIssue");

	harness.writeFile("draft-plan.md", "# Draft plan\n");
	await harness.runPostTool("edit");
	assert.equal(harness.readPiState().statusKey, "inProgress");
});
