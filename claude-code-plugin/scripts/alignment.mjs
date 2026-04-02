#!/usr/bin/env node

/**
 * coding-agents-alignment — Claude Code hook handler.
 *
 * Entry points:
 *   node alignment.mjs prompt        — UserPromptSubmit
 *   node alignment.mjs post-tool     — PostToolUse (Edit/Write)
 *   node alignment.mjs check-finish  — PostToolUse (Bash) + Stop
 *   node alignment.mjs cmd <action>  — Slash-command handler
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.mjs");
const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".cache", "coding-agents-alignment");

// ── Action handlers ─────────────────────────────────────────────────────

async function handlePrompt(_input, sessionId, cwd) {
	const config = loadConfig(cwd);
	if (!config) return;

	const state = readState(sessionId);
	const prompt = _input.user_prompt ?? "";

	if (state.mode === "idle") {
		writeState(sessionId, { ...state, mode: "pending", pendingPrompt: prompt });
	} else if (state.mode === "pending") {
		writeState(sessionId, { ...state, pendingPrompt: prompt });
	}
}

async function handlePostTool(_input, sessionId, cwd) {
	const config = loadConfig(cwd);
	if (!config) return;

	const state = readState(sessionId);

	if (state.mode === "pending") {
		await createOrLinkItem(sessionId, cwd, config, state);
	} else if (state.mode === "aligned" && state.statusKey === "todo") {
		syncItem(sessionId, cwd, config, state, "inProgress");
	}
}

async function handleCheckFinish(_input, sessionId, cwd) {
	const config = loadConfig(cwd);
	if (!config) return;

	const state = readState(sessionId);
	checkForFinish(sessionId, cwd, config, state);
}

async function handleCommand(command, sessionId, cwd) {
	const state = readState(sessionId);

	switch (command) {
		case "status": {
			if (state.mode === "aligned") {
				const pr = state.prUrl ? ` ${state.prUrl}` : "";
				console.log(`📋 ${state.itemTitle ?? state.itemId} [${state.statusKey}]${pr}`);
			} else {
				console.log(`alignment: ${state.mode}`);
			}
			break;
		}
		case "finish": {
			if (state.mode !== "aligned") {
				console.log("no aligned item");
				return;
			}
			const config = loadConfig(cwd);
			if (!config) return;
			syncItem(sessionId, cwd, config, state, "finished");
			console.log("✓ marked as done");
			break;
		}
		case "unlink": {
			writeState(sessionId, { mode: "unlinked" });
			console.log("alignment stopped");
			break;
		}
		case "align": {
			if (state.mode === "aligned") {
				console.log(`already aligned: ${state.itemTitle}`);
				break;
			}
			const config = loadConfig(cwd);
			if (!config) {
				console.log("alignment not configured");
				break;
			}
			const pendingPrompt = state.pendingPrompt?.trim() || "Track current work manually";
			writeState(sessionId, { ...state, mode: "pending", pendingPrompt });
			await createOrLinkItem(sessionId, cwd, config, { ...state, mode: "pending", pendingPrompt });
			const nextState = readState(sessionId);
			if (nextState.mode === "aligned") {
				console.log(`alignment started: ${nextState.itemTitle}`);
			} else if (nextState.mode === "pending") {
				console.log("alignment pending");
			} else {
				console.log("alignment start failed");
			}
			break;
		}
		case "resync": {
			if (state.mode !== "aligned" || !state.itemId) {
				console.log("no aligned item to resync");
				return;
			}
			const config = loadConfig(cwd);
			if (!config) return;
			const gitState = runWorker(cwd, { command: "gitState" });
			try {
				runWorker(cwd, {
					command: "updateItem",
					itemId: state.itemId,
					statusKey: state.statusKey ?? "inProgress",
					repo: gitState.repo,
					branch: gitState.branch,
					prUrl: gitState.prUrl,
					agent: "claude-code",
				});
				console.log("✓ synced");
			} catch (error) {
				if (!isMissingItemError(error) || !(await recoverMissingItem(sessionId, cwd, config, state, state.statusKey ?? "inProgress", gitState))) {
					throw error;
				}
				console.log("✓ recovered and synced");
			}
			break;
		}
		default:
			console.log(`unknown command: ${command}`);
	}
}

// ── Core alignment logic ────────────────────────────────────────────────

async function createOrLinkItem(sessionId, cwd, config, state) {
	let gitState, snapshot;
	try {
		[gitState, snapshot] = await Promise.all([
			Promise.resolve(runWorker(cwd, { command: "gitState" })),
			Promise.resolve(runWorker(cwd, { command: "projectSnapshot" })),
		]);
	} catch {
		writeState(sessionId, { mode: "idle" });
		return;
	}

	// Branch-based match
	const branchMatch = gitState.branch
		? snapshot.items.find((item) => item.branch === gitState.branch)
		: undefined;

	if (branchMatch) {
		const rawKey = statusLabelToKey(config, branchMatch.status) ?? "inProgress";
		const effectiveKey = rawKey === "todo" ? "inProgress" : rawKey;

		writeState(sessionId, {
			mode: "aligned",
			itemId: branchMatch.id,
			itemTitle: branchMatch.title,
			contentId: branchMatch.contentId,
			contentUrl: branchMatch.contentUrl,
			statusKey: effectiveKey,
			repo: gitState.repo,
			repoFullName: gitState.repoFullName,
			branch: gitState.branch,
			baseHeadSha: gitState.headSha,
			prUrl: gitState.prUrl ?? branchMatch.prUrl,
			lastSyncAt: Date.now(),
		});

		if (rawKey === "todo") {
			tryWorker(cwd, {
				command: "updateItem",
				itemId: branchMatch.id,
				statusKey: "inProgress",
				repo: gitState.repo,
				branch: gitState.branch,
				prUrl: gitState.prUrl ?? branchMatch.prUrl,
				agent: "claude-code",
			});
		}
	} else {
		const title = generateSummary(state.pendingPrompt ?? "Untitled work");
		const body = buildDraftBody(state.pendingPrompt ?? "", gitState);

		let created;
		try {
			created = runWorker(cwd, {
				command: "createItem",
				title,
				body,
				repoFullName: gitState.repoFullName,
				statusKey: "inProgress",
				repo: gitState.repo,
				branch: gitState.branch,
				agent: "claude-code",
			});
		} catch {
			writeState(sessionId, { mode: "idle" });
			return;
		}

		writeState(sessionId, {
			mode: "aligned",
			itemId: created.itemId,
			itemTitle: created.title,
			contentId: created.contentId,
			contentUrl: created.contentUrl,
			statusKey: "inProgress",
			repo: gitState.repo,
			repoFullName: gitState.repoFullName,
			branch: gitState.branch,
			baseHeadSha: gitState.headSha,
			prUrl: gitState.prUrl,
			lastSyncAt: Date.now(),
		});
	}
}

function isMissingItemError(error) {
	const message = messageOf(error).toLowerCase();
	return (
		message.includes("projectv2item") ||
		message.includes("could not resolve") ||
		message.includes("not found") ||
		message.includes("does not exist")
	);
}

async function recoverMissingItem(sessionId, cwd, config, state, nextStatus, extra = {}) {
	if (state.mode !== "aligned") return false;

	const gitState = extra.branch || extra.repo || extra.prUrl
		? {
			repo: extra.repo ?? state.repo ?? "",
			branch: extra.branch ?? state.branch ?? "",
			prUrl: extra.prUrl ?? state.prUrl,
			defaultBranch: undefined,
			headSha: state.baseHeadSha,
			repoFullName: undefined,
		}
		: runWorker(cwd, { command: "gitState" });
	const snapshot = runWorker(cwd, { command: "projectSnapshot" });
	const branchMatch = gitState.branch ? snapshot.items.find((item) => item.branch === gitState.branch) : undefined;

	if (branchMatch) {
		runWorker(cwd, {
			command: "updateItem",
			itemId: branchMatch.id,
			statusKey: nextStatus,
			repo: gitState.repo ?? state.repo,
			branch: gitState.branch ?? state.branch,
			prUrl: gitState.prUrl ?? state.prUrl,
			agent: "claude-code",
		});
		writeState(sessionId, {
			...state,
			mode: "aligned",
			itemId: branchMatch.id,
			itemTitle: branchMatch.title,
			contentId: branchMatch.contentId,
			contentUrl: branchMatch.contentUrl,
			statusKey: nextStatus,
			repo: gitState.repo ?? state.repo,
			branch: gitState.branch ?? state.branch,
			prUrl: gitState.prUrl ?? state.prUrl,
			lastSyncAt: Date.now(),
		});
		return true;
	}

	if (state.contentId) {
		try {
			const readded = runWorker(cwd, {
				command: "addItemByContentId",
				contentId: state.contentId,
				statusKey: nextStatus,
				repo: gitState.repo ?? state.repo,
				branch: gitState.branch ?? state.branch,
				prUrl: gitState.prUrl ?? state.prUrl,
				agent: "claude-code",
			});
			writeState(sessionId, {
				...state,
				mode: "aligned",
				itemId: readded.itemId,
				statusKey: nextStatus,
				repo: gitState.repo ?? state.repo,
				branch: gitState.branch ?? state.branch,
				prUrl: gitState.prUrl ?? state.prUrl,
				lastSyncAt: Date.now(),
			});
			return true;
		} catch {
			// fall through
		}
	}

	const title = state.itemTitle ?? generateSummary(state.pendingPrompt ?? "Untitled work");
	const created = runWorker(cwd, {
		command: "createItem",
		title,
		body: buildDraftBody(state.pendingPrompt ?? title, gitState),
		repoFullName: gitState.repoFullName,
		statusKey: nextStatus,
		repo: gitState.repo ?? state.repo,
		branch: gitState.branch ?? state.branch,
		agent: "claude-code",
	});
	writeState(sessionId, {
		...state,
		mode: "aligned",
		itemId: created.itemId,
		itemTitle: created.title,
		contentId: created.contentId,
		contentUrl: created.contentUrl,
		statusKey: nextStatus,
		repo: gitState.repo ?? state.repo,
		branch: gitState.branch ?? state.branch,
		prUrl: gitState.prUrl ?? state.prUrl,
		lastSyncAt: Date.now(),
	});
	return true;
}

function syncItem(sessionId, cwd, config, state, nextStatus, extra = {}) {
	if (state.mode !== "aligned" || !state.itemId) return;

	const updated = {
		...state,
		statusKey: nextStatus,
		branch: extra.branch ?? state.branch,
		repo: extra.repo ?? state.repo,
		prUrl: extra.prUrl ?? state.prUrl,
		lastSyncAt: Date.now(),
	};
	writeState(sessionId, updated);

	try {
		runWorker(cwd, {
			command: "updateItem",
			itemId: state.itemId,
			statusKey: nextStatus,
			repo: extra.repo ?? state.repo,
			branch: extra.branch ?? state.branch,
			prUrl: extra.prUrl ?? state.prUrl,
			agent: "claude-code",
		});
	} catch (error) {
		if (!isMissingItemError(error)) return;
		void recoverMissingItem(sessionId, cwd, config, updated, nextStatus, extra);
	}
}

function checkForFinish(sessionId, cwd, config, state) {
	if (state.mode !== "aligned" || state.statusKey === "finished" || !state.itemId) return;

	const now = Date.now();
	if (state.lastFinishCheckAt && now - state.lastFinishCheckAt < config.finishCheckIntervalMs) return;

	writeState(sessionId, { ...state, lastFinishCheckAt: now });

	let gitState;
	try {
		gitState = runWorker(cwd, { command: "gitState" });
	} catch {
		return;
	}

	const committedToDefault =
		Boolean(gitState.defaultBranch) &&
		gitState.branch === gitState.defaultBranch &&
		Boolean(gitState.headSha) &&
		gitState.headSha !== state.baseHeadSha;

	if (!gitState.prUrl && !committedToDefault) return;

	syncItem(sessionId, cwd, config, state, "finished", gitState);
}

// ── State management ────────────────────────────────────────────────────

function readState(sessionId) {
	const filePath = statePath(sessionId);
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return { mode: "idle" };
	}
}

function writeState(sessionId, state) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const filePath = statePath(sessionId);
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
	fs.renameSync(tmp, filePath);
}

function statePath(sessionId) {
	return path.join(STATE_DIR, `${sessionId}.json`);
}

// ── Config ──────────────────────────────────────────────────────────────

const CONFIG_FILE = ".coding-agents-alignment.json";

const DEFAULTS = {
	statusFieldName: "Status",
	repoFieldName: "Repo",
	branchFieldName: "Branch",
	prUrlFieldName: "PR URL",
	agentFieldName: "Agent",
	statuses: { todo: "Todo", inProgress: "In Progress", finished: "Done" },
	finishCheckIntervalMs: 60_000,
};

function loadConfig(startDir) {
	const filePath = findConfigFile(startDir);
	const fc = filePath ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};

	const githubOwner = process.env.CODING_AGENTS_ALIGNMENT_GITHUB_OWNER ?? fc.githubOwner;
	const githubProjectNumber = Number(process.env.CODING_AGENTS_ALIGNMENT_GITHUB_PROJECT_NUMBER ?? fc.githubProjectNumber);
	if (!githubOwner || !Number.isFinite(githubProjectNumber) || githubProjectNumber <= 0) return null;

	return {
		githubOwner,
		githubProjectNumber,
		repo: process.env.CODING_AGENTS_ALIGNMENT_REPO ?? fc.repo,
		statusFieldName: process.env.CODING_AGENTS_ALIGNMENT_STATUS_FIELD ?? fc.statusFieldName ?? DEFAULTS.statusFieldName,
		statuses: {
			todo: process.env.CODING_AGENTS_ALIGNMENT_STATUS_TODO ?? fc.statuses?.todo ?? DEFAULTS.statuses.todo,
			inProgress: process.env.CODING_AGENTS_ALIGNMENT_STATUS_IN_PROGRESS ?? fc.statuses?.inProgress ?? DEFAULTS.statuses.inProgress,
			finished: process.env.CODING_AGENTS_ALIGNMENT_STATUS_FINISHED ?? fc.statuses?.finished ?? DEFAULTS.statuses.finished,
		},
		finishCheckIntervalMs: typeof fc.finishCheckIntervalMs === "number" ? fc.finishCheckIntervalMs : DEFAULTS.finishCheckIntervalMs,
	};
}

function statusLabelToKey(config, label) {
	if (!label) return undefined;
	if (label === config.statuses.todo) return "todo";
	if (label === config.statuses.inProgress) return "inProgress";
	if (label === config.statuses.finished) return "finished";
	return undefined;
}

function findConfigFile(startDir) {
	let current = path.resolve(startDir);
	while (true) {
		const candidate = path.join(current, CONFIG_FILE);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

// ── Summary ─────────────────────────────────────────────────────────────

const LEADING_PHRASES = [
	/^please\s+/i,
	/^can you\s+/i,
	/^i have this idea[:\s-]*/i,
	/^let'?s\s+/i,
	/^we need to\s+/i,
	/^help me\s+/i,
];

function generateSummary(prompt) {
	const singleLine = prompt.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
	const firstSentence = singleLine.split(/[.!?]\s/)[0] ?? singleLine;
	let summary = firstSentence;
	for (const re of LEADING_PHRASES) summary = summary.replace(re, "");
	summary = summary.replace(/^to\s+/i, "").trim();
	if (!summary) summary = "Untitled work";
	if (summary.length > 72) summary = `${summary.slice(0, 69).trimEnd()}...`;
	return summary.charAt(0).toUpperCase() + summary.slice(1);
}

// ── Worker ──────────────────────────────────────────────────────────────

function runWorker(cwd, payload) {
	try {
		const raw = execFileSync(process.execPath, [WORKER_PATH], {
			cwd,
			input: JSON.stringify(payload),
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 25_000,
		});
		const parsed = JSON.parse(raw);
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.result;
	} catch (error) {
		const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout || "") : "";
		const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr || "") : "";
		if (stdout.trim()) {
			let parsed;
			try {
				parsed = JSON.parse(stdout);
			} catch (parseError) {
				throw new Error(`Failed to parse worker output: ${String(parseError)}\n${stdout || stderr}`);
			}
			if (!parsed.ok) throw new Error(parsed.error);
			return parsed.result;
		}
		throw error;
	}
}

function tryWorker(cwd, payload) {
	try {
		return runWorker(cwd, payload);
	} catch {
		return undefined;
	}
}

// ── Utilities ───────────────────────────────────────────────────────────

function buildDraftBody(prompt, gitState) {
	const excerpt = prompt.replace(/\s+/g, " ").trim().slice(0, 500);
	return [
		"Created by coding-agents-alignment",
		`Created at: ${new Date().toISOString()}`,
		`Repo: ${gitState.repo}`,
		`Branch: ${gitState.branch}`,
		"",
		"Prompt excerpt:",
		excerpt,
	].join("\n");
}

function messageOf(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => { data += chunk; });
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

// ── Main ────────────────────────────────────────────────────────────────

const action = process.argv[2];

try {
	if (action === "cmd") {
		const command = process.argv[3];
		const sessionId = process.argv[4];
		const cwd = process.argv[5] || process.cwd();
		if (!sessionId) process.exit(0);
		await handleCommand(command, sessionId, cwd);
	} else {
		const input = JSON.parse(await readStdin());
		const sessionId = input.session_id;
		const cwd = input.cwd ?? process.cwd();
		if (!sessionId) process.exit(0);

		switch (action) {
			case "prompt":
				await handlePrompt(input, sessionId, cwd);
				break;
			case "post-tool":
				await handlePostTool(input, sessionId, cwd);
				break;
			case "check-finish":
				await handleCheckFinish(input, sessionId, cwd);
				break;
			default:
				break;
		}
	}
} catch (error) {
	const msg = error instanceof Error ? error.message : String(error);
	process.stderr.write(`[alignment] ${msg}\n`);
}

process.exit(0);
