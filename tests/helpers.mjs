import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CLAUDE_ALIGNMENT_SCRIPT = path.join(REPO_ROOT, "claude-code-plugin", "scripts", "alignment.mjs");
const FAKE_GH_SCRIPT = path.join(REPO_ROOT, "tests", "fake-gh.mjs");
let compiledPiModulePromise;

export function createHarness(name) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `alignment-${sanitize(name)}-`));
	const homeDir = path.join(root, "home");
	const binDir = path.join(root, "bin");
	const remoteDir = path.join(root, "remotes", "acme");
	const remotePath = path.join(remoteDir, "demo.git");
	const repoDir = path.join(root, "workspace", "demo");
	const ghStateFile = path.join(root, "gh-state.json");

	fs.mkdirSync(homeDir, { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(remoteDir, { recursive: true });
	fs.mkdirSync(path.dirname(repoDir), { recursive: true });
	fs.copyFileSync(FAKE_GH_SCRIPT, path.join(binDir, "gh"));
	fs.chmodSync(path.join(binDir, "gh"), 0o755);

	writeJson(ghStateFile, createInitialGhState());

	exec("git", ["init", "--bare", remotePath], { cwd: root });
	exec("git", ["init", repoDir], { cwd: root });
	exec("git", ["config", "user.name", "Test User"], { cwd: repoDir });
	exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	exec("git", ["checkout", "-b", "main"], { cwd: repoDir });
	fs.writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
	exec("git", ["add", "README.md"], { cwd: repoDir });
	exec("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
	exec("git", ["remote", "add", "origin", remotePath], { cwd: repoDir });
	exec("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
	exec("git", ["checkout", "-b", "feature/test"], { cwd: repoDir });

	writeJson(path.join(repoDir, ".coding-agents-alignment.json"), {
		githubOwner: "acme",
		githubProjectNumber: 1,
		repo: "demo",
	});

	const env = {
		...process.env,
		HOME: homeDir,
		PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
		CODING_AGENTS_ALIGNMENT_TEST_GH_STATE: ghStateFile,
	};

	return {
		root,
		homeDir,
		repoDir,
		remotePath,
		ghStateFile,
		env,
		repoFullName: "acme/demo",
		sessionId: `session-${sanitize(name)}`,
		runPrompt(prompt) {
			runClaudeAction("prompt", { session_id: this.sessionId, cwd: repoDir, user_prompt: prompt }, env);
		},
		runPostTool() {
			runClaudeAction("post-tool", { session_id: this.sessionId, cwd: repoDir }, env);
		},
		runCheckFinish() {
			runClaudeAction("check-finish", { session_id: this.sessionId, cwd: repoDir }, env);
		},
		runCommand(command) {
			return exec(process.execPath, [CLAUDE_ALIGNMENT_SCRIPT, "cmd", command, this.sessionId, repoDir], { cwd: repoDir, env }).stdout.trim();
		},
		readSessionState() {
			return readJson(path.join(homeDir, ".cache", "coding-agents-alignment", `${this.sessionId}.json`));
		},
		readGhState() {
			return readJson(ghStateFile);
		},
		writeGhState(nextState) {
			writeJson(ghStateFile, nextState);
		},
		writeFile(relativePath, content) {
			const target = path.join(repoDir, relativePath);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		},
		appendFile(relativePath, content) {
			fs.appendFileSync(path.join(repoDir, relativePath), content);
		},
		git(args) {
			return exec("git", args, { cwd: repoDir, env }).stdout.trim();
		},
	};
}

export async function createPiHarness(name) {
	const base = createHarness(`pi-${name}`);
	const module = await loadCompiledPiExtension();
	const handlers = new Map();
	const commands = new Map();
	const branchEntries = [];
	const notifications = [];
	const statuses = new Map();

	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		appendEntry(customType, data) {
			branchEntries.push({ type: "custom", customType, data });
		},
	};

	const ctx = {
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify(message, type = "info") {
				notifications.push({ message, type });
			},
			onTerminalInput: () => () => undefined,
			setStatus(key, text) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setWorkingMessage: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => undefined,
			theme: {},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => undefined,
		},
		hasUI: true,
		cwd: base.repoDir,
		sessionManager: {
			getBranch: () => branchEntries,
		},
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
	};

	module.default(pi);

	const withEnv = async (work) => {
		const previousEnv = {
			HOME: process.env.HOME,
			PATH: process.env.PATH,
			CODING_AGENTS_ALIGNMENT_TEST_GH_STATE: process.env.CODING_AGENTS_ALIGNMENT_TEST_GH_STATE,
		};
		Object.assign(process.env, {
			HOME: base.homeDir,
			PATH: base.env.PATH,
			CODING_AGENTS_ALIGNMENT_TEST_GH_STATE: base.ghStateFile,
		});
		try {
			return await work();
		} finally {
			restoreEnv("HOME", previousEnv.HOME);
			restoreEnv("PATH", previousEnv.PATH);
			restoreEnv("CODING_AGENTS_ALIGNMENT_TEST_GH_STATE", previousEnv.CODING_AGENTS_ALIGNMENT_TEST_GH_STATE);
		}
	};

	const emit = async (eventName, event = {}) => {
		await withEnv(async () => {
			for (const handler of handlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
			await drainPiBackground(handlers, ctx);
		});
	};

	const runCommand = async (name, args = "") => {
		const command = commands.get(name);
		if (!command) throw new Error(`pi command not registered: ${name}`);
		await withEnv(async () => {
			await command.handler(args, ctx);
			await drainPiBackground(handlers, ctx);
		});
		return notifications.at(-1)?.message;
	};

	await emit("session_start", {});

	return {
		...base,
		notifications,
		statuses,
		emit,
		async runPrompt(prompt) {
			await emit("before_agent_start", { prompt });
		},
		async runPostTool(toolName = "edit", isError = false) {
			await emit("tool_execution_end", { toolName, isError });
		},
		async runBashTool() {
			await emit("tool_execution_end", { toolName: "bash", isError: false });
		},
		async runTurnEnd() {
			await emit("turn_end", {});
		},
		readPiState() {
			return branchEntries
				.filter((entry) => entry.customType === "coding-agents-alignment-state")
				.map((entry) => entry.data)
				.at(-1) ?? { mode: "idle" };
		},
		async runPiCommand(name, args = "") {
			return runCommand(name, args);
		},
	};
}

export function addExistingBranchItem(harness, { title, branch, status = "Planning" }) {
	const ghState = harness.readGhState();
	const issue = createIssueRecord(ghState, harness.repoFullName, title, "Preexisting item");
	const item = {
		id: `ITEM_${ghState.nextItemNumber++}`,
		contentType: "Issue",
		contentId: issue.node_id,
		contentUrl: issue.html_url,
		title,
		body: issue.body,
		fieldValues: {
			Status: status,
			Repo: "demo",
			Branch: branch,
			Agent: "claude-code",
		},
	};
	ghState.project.items.push(item);
	harness.writeGhState(ghState);
	return { issue, item };
}

export function setOpenPullRequest(harness, branch, url = `https://github.com/${harness.repoFullName}/pull/1`) {
	const ghState = harness.readGhState();
	ghState.openPullRequests = [{ head: branch, url }];
	harness.writeGhState(ghState);
}

export function clearFailure(harness) {
	const ghState = harness.readGhState();
	ghState.fail = { projectFetch: false, issueCreate: false, commentIssue: false };
	harness.writeGhState(ghState);
}

export function setFailure(harness, failureKey, value) {
	const ghState = harness.readGhState();
	ghState.fail[failureKey] = value;
	harness.writeGhState(ghState);
}

function runClaudeAction(action, payload, env) {
	exec(process.execPath, [CLAUDE_ALIGNMENT_SCRIPT, action], {
		cwd: payload.cwd,
		env,
		input: JSON.stringify(payload),
	});
}

function exec(command, args, options) {
	return {
		stdout: execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			...options,
		}),
	};
}

function createInitialGhState() {
	return {
		currentUser: "tester",
		defaultBranch: "main",
		nextIssueNumber: 1,
		nextItemNumber: 1,
		nextDraftNumber: 1,
		fail: {
			projectFetch: false,
			issueCreate: false,
			commentIssue: false,
		},
		openPullRequests: [],
		repos: {
			"acme/demo": { issues: [] },
		},
		project: {
			id: "PROJECT_1",
			fields: [
				{
					id: "FIELD_STATUS",
					name: "Status",
					type: "single_select",
					options: [
						{ id: "OPTION_PLANNING", name: "Planning" },
						{ id: "OPTION_IN_PROGRESS", name: "In Progress" },
						{ id: "OPTION_DONE", name: "Done" },
					],
				},
				{ id: "FIELD_REPO", name: "Repo", type: "text" },
				{ id: "FIELD_BRANCH", name: "Branch", type: "text" },
				{ id: "FIELD_PR_URL", name: "PR URL", type: "text" },
				{ id: "FIELD_AGENT", name: "Agent", type: "text" },
			],
			items: [],
		},
	};
}

function createIssueRecord(state, repoFullName, title, body) {
	const repo = state.repos[repoFullName];
	const issueNumber = state.nextIssueNumber++;
	const issue = {
		number: issueNumber,
		node_id: `ISSUE_${issueNumber}`,
		html_url: `https://github.com/${repoFullName}/issues/${issueNumber}`,
		title,
		body,
		assignees: ["tester"],
		comments: [],
	};
	repo.issues.push(issue);
	return issue;
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sanitize(value) {
	return value.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

async function loadCompiledPiExtension() {
	if (!compiledPiModulePromise) {
		compiledPiModulePromise = (async () => {
			const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "alignment-pi-build-"));
			execFileSync(path.join(REPO_ROOT, "node_modules", ".bin", "tsc"), [
				"--project",
				path.join(REPO_ROOT, "tsconfig.json"),
				"--noEmit",
				"false",
				"--outDir",
				buildDir,
			], {
				cwd: REPO_ROOT,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const workerSource = path.join(REPO_ROOT, "extensions", "alignment", "worker.mjs");
			const workerTarget = path.join(buildDir, "worker.mjs");
			fs.mkdirSync(path.dirname(workerTarget), { recursive: true });
			fs.copyFileSync(workerSource, workerTarget);
			return import(pathToFileURL(path.join(buildDir, "index.js")).href);
		})();
	}
	return compiledPiModulePromise;
}

function restoreEnv(key, value) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

async function drainPiBackground(handlers, ctx) {
	for (let i = 0; i < 3; i += 1) {
		for (const shutdownHandler of handlers.get("session_shutdown") ?? []) {
			await shutdownHandler({}, ctx);
		}
	}
}
