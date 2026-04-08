import test from "node:test";
import assert from "node:assert/strict";

import {
	addExistingBranchItem,
	clearFailure,
	createHarness,
	setFailure,
	setOpenPullRequest,
} from "./helpers.mjs";

test("creates a Planning item on the first substantive prompt and ignores lightweight follow-ups", () => {
	const harness = createHarness("planning-prompt");

	harness.runPrompt("plan the oauth callback recovery flow");

	const session = harness.readSessionState();
	const ghState = harness.readGhState();
	const repo = ghState.repos[harness.repoFullName];

	assert.equal(session.mode, "aligned");
	assert.equal(session.statusKey, "planning");
	assert.equal(ghState.project.items.length, 1);
	assert.equal(repo.issues.length, 1);
	assert.equal(repo.issues[0].assignees[0], "tester");
	assert.match(repo.issues[0].body, /## Goal/);
	assert.match(repo.issues[0].body, /oauth callback recovery flow/i);

	harness.runPrompt("ok");

	assert.equal(harness.readGhState().project.items.length, 1);
});

test("promotes to In Progress on first code change and comments Markdown planning artifacts", () => {
	const harness = createHarness("planning-artifacts");

	harness.runPrompt("plan the alignment migration");
	harness.runPrompt("also keep the github project fields backward compatible");
	harness.writeFile("PLAN.md", "# Migration plan\n\n- Keep legacy todo mapping\n");

	harness.runPostTool();

	const session = harness.readSessionState();
	const ghState = harness.readGhState();
	const issue = ghState.repos[harness.repoFullName].issues[0];

	assert.equal(session.statusKey, "inProgress");
	assert.equal(ghState.project.items[0].fieldValues.Status, "In Progress");
	assert.equal(issue.comments.length, 1);
	assert.match(issue.comments[0].body, /Planning Artifacts/);
	assert.match(issue.comments[0].body, /PLAN\.md/);
	assert.match(issue.comments[0].body, /github project fields backward compatible/i);
});

test("open PRs do not finish work before merge", () => {
	const harness = createHarness("open-pr");

	harness.runPrompt("implement branch-based recovery");
	harness.runPostTool();
	setOpenPullRequest(harness, "feature/test");

	harness.runCheckFinish();

	assert.equal(harness.readSessionState().statusKey, "inProgress");
	assert.equal(harness.readGhState().project.items[0].fieldValues.Status, "In Progress");
});

test("marks work Done when the feature branch head lands on the default branch", () => {
	const harness = createHarness("merged-feature");

	harness.runPrompt("ship the finish detection update");
	harness.runPostTool();

	harness.writeFile("src.js", "export const value = 1;\n");
	harness.git(["add", "src.js"]);
	harness.git(["commit", "-m", "Implement feature"]);

	harness.git(["checkout", "main"]);
	harness.git(["merge", "--no-ff", "feature/test", "-m", "Merge feature"]);
	harness.git(["push", "origin", "main"]);
	harness.git(["checkout", "feature/test"]);

	harness.runCheckFinish();

	assert.equal(harness.readSessionState().statusKey, "finished");
	assert.equal(harness.readGhState().project.items[0].fieldValues.Status, "Done");
});

test("relinks an existing branch item instead of creating a duplicate", () => {
	const harness = createHarness("branch-relink");
	const existing = addExistingBranchItem(harness, {
		title: "Existing branch work",
		branch: "feature/test",
		status: "Planning",
	});

	harness.runPrompt("work on something that would otherwise create a duplicate");

	const session = harness.readSessionState();
	const ghState = harness.readGhState();

	assert.equal(session.itemId, existing.item.id);
	assert.equal(ghState.project.items.length, 1);
	assert.equal(ghState.repos[harness.repoFullName].issues.length, 1);
});

test("supports manual finish and unlink commands", () => {
	const harness = createHarness("finish-and-unlink");

	harness.runPrompt("implement unlink support for alignment sessions");
	harness.runPostTool();

	assert.equal(harness.runCommand("finish"), "marked as done");
	assert.equal(harness.readSessionState().statusKey, "finished");

	assert.equal(harness.runCommand("unlink"), "alignment stopped");
	harness.runPrompt("start a different task after unlink");

	const session = harness.readSessionState();
	assert.equal(session.mode, "unlinked");
	assert.equal(harness.readGhState().project.items.length, 1);
});

test("auto-switches to a new task on a new branch without confirmation", () => {
	const harness = createHarness("task-switch");

	harness.runPrompt("plan task one for the initial migration flow");

	harness.git(["checkout", "main"]);
	harness.git(["checkout", "-b", "feature/two"]);

	harness.runPrompt("now implement a completely different task on the new branch");

	const session = harness.readSessionState();
	const ghState = harness.readGhState();

	assert.equal(ghState.project.items.length, 2);
	assert.equal(session.branch, "feature/two");
	assert.match(session.itemTitle, /completely different task/i);
});

test("resync recovers a missing project item using the original issue content id", () => {
	const harness = createHarness("resync-recovery");

	harness.runPrompt("plan recovery for a missing project item on resync");
	const before = harness.readSessionState();
	const ghState = harness.readGhState();
	ghState.project.items = [];
	harness.writeGhState(ghState);

	assert.equal(harness.runCommand("resync"), "alignment recovered and synced");

	const after = harness.readSessionState();
	const afterGh = harness.readGhState();

	assert.notEqual(after.itemId, before.itemId);
	assert.equal(after.contentId, before.contentId);
	assert.equal(afterGh.project.items.length, 1);
	assert.equal(afterGh.project.items[0].contentId, before.contentId);
});

test("records non-blocking failures and retries on later lifecycle events", () => {
	const harness = createHarness("failure-retry");

	setFailure(harness, "projectFetch", true);
	harness.runPrompt("plan retry behavior after a project fetch failure");

	const failedState = harness.readSessionState();
	assert.equal(failedState.mode, "pending");
	assert.match(failedState.lastError, /project .* not found/i);

	clearFailure(harness);
	harness.runPostTool();

	const recoveredState = harness.readSessionState();
	assert.equal(recoveredState.statusKey, "inProgress");
	assert.equal(recoveredState.lastError, undefined);
	assert.equal(harness.readGhState().project.items.length, 1);
});

test("falls back to a draft project item when issue creation fails", () => {
	const harness = createHarness("draft-fallback");

	setFailure(harness, "issueCreate", true);
	harness.runPrompt("plan the draft fallback when issue creation fails");

	const session = harness.readSessionState();
	const ghState = harness.readGhState();

	assert.equal(session.statusKey, "planning");
	assert.equal(ghState.project.items.length, 1);
	assert.equal(ghState.project.items[0].contentType, "DraftIssue");
	assert.equal(ghState.repos[harness.repoFullName].issues.length, 0);

	harness.writeFile("draft-plan.md", "# Draft plan\n");
	harness.runPostTool();

	assert.equal(harness.readSessionState().statusKey, "inProgress");
	assert.equal(harness.readGhState().repos[harness.repoFullName].issues.length, 0);
});
