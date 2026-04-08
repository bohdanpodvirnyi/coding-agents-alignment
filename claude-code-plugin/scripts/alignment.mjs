#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.mjs");
const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".cache", "coding-agents-alignment");

async function handlePrompt(input, sessionId, cwd) {
	const config = loadConfig(cwd);
	if (!config) return;

	const state = readState(sessionId);
	if (state.mode === "unlinked") return;

	const prompt = input.user_prompt ?? "";
	if (!isSubstantivePrompt(prompt)) return;

	if (state.mode === "idle" || state.mode === "pending") {
		const recentPrompts = appendRecentPrompt(undefined, prompt);
		writeState(sessionId, {
			...state,
			mode: "pending",
			pendingPrompt: prompt,
			recentPrompts,
			planningArtifactsAttachedAt: undefined,
		});
		await createOrLinkItem(sessionId, cwd, config, {
			promptSeed: prompt,
			recentPrompts,
			desiredStatus: "planning",
			preserveExisting: false,
		});
		return;
	}

	if (state.mode === "aligned" && isLikelyTaskSwitch(prompt, state.itemTitle)) {
		await createOrLinkItem(sessionId, cwd, config, {
			promptSeed: prompt,
			recentPrompts: appendRecentPrompt(undefined, prompt),
			desiredStatus: "planning",
			preserveExisting: true,
		});
		return;
	}

	writeState(sessionId, {
		...state,
		pendingPrompt: prompt,
		recentPrompts: appendRecentPrompt(state.recentPrompts, prompt),
	});
}

async function handlePostTool(_input, sessionId, cwd) {
	const config = loadConfig(cwd);
	if (!config) return;

	let state = readState(sessionId);

	if (state.mode === "pending") {
		const created = await createOrLinkItem(sessionId, cwd, config, {
			promptSeed: getPromptSeed(state),
			recentPrompts: state.recentPrompts ?? [getPromptSeed(state)],
			desiredStatus: "planning",
			preserveExisting: false,
		});
		if (!created) return;
		state = readState(sessionId);
	}

	if (state.mode === "aligned" && state.statusKey === "planning") {
		await syncItem(sessionId, cwd, config, state, "inProgress");
	}
}

async function handleCheckFinish(_input, sessionId, cwd) {
	const config = loadConfig(cwd);
	if (!config) return;
	await checkForFinish(sessionId, cwd, config);
}

async function handleCommand(command, sessionId, cwd) {
	const state = readState(sessionId);

	switch (command) {
		case "status": {
			if (state.mode === "aligned") {
				const parts = [`📋 ${state.itemTitle ?? state.itemId} [${state.statusKey}]`];
				if (state.prUrl) parts.push(state.prUrl);
				if (state.lastError) parts.push(`error: ${state.lastError}`);
				console.log(parts.join(" "));
			} else if (state.lastError) {
				console.log(`alignment: ${state.mode} (last error: ${state.lastError})`);
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
			await syncItem(sessionId, cwd, config, state, "finished");
			console.log("marked as done");
			break;
		}
		case "unlink": {
			writeState(sessionId, { ...state, mode: "unlinked" });
			console.log("alignment stopped");
			break;
		}
		case "align": {
			const config = loadConfig(cwd);
			if (!config) {
				console.log("alignment not configured");
				break;
			}
			const prompt = getPromptSeed(state);
			writeState(sessionId, {
				...state,
				mode: "pending",
				pendingPrompt: prompt,
				recentPrompts: appendRecentPrompt(undefined, prompt),
				planningArtifactsAttachedAt: undefined,
			});
			const created = await createOrLinkItem(sessionId, cwd, config, {
				promptSeed: prompt,
				recentPrompts: appendRecentPrompt(undefined, prompt),
				desiredStatus: "planning",
				preserveExisting: false,
			});
			console.log(created ? "alignment started" : "alignment pending");
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
				clearError(sessionId);
				console.log("alignment synced");
			} catch (error) {
				if (!isMissingItemError(error) || !(await recoverMissingItem(sessionId, cwd, config, state, state.statusKey ?? "inProgress", gitState))) {
					throw error;
				}
				console.log("alignment recovered and synced");
			}
			break;
		}
		default:
			console.log(`unknown command: ${command}`);
	}
}

async function createOrLinkItem(sessionId, cwd, config, options) {
	const previousState = readState(sessionId);

	try {
		const [gitState, snapshot] = await Promise.all([
			Promise.resolve(runWorker(cwd, { command: "gitState" })),
			Promise.resolve(runWorker(cwd, { command: "projectSnapshot" })),
		]);

		const branchMatch = gitState.branch ? snapshot.items.find((item) => item.branch === gitState.branch) : undefined;

		if (branchMatch) {
			const effectiveStatus = statusLabelToKey(config, branchMatch.status) ?? options.desiredStatus;
			runWorker(cwd, {
				command: "updateItem",
				itemId: branchMatch.id,
				statusKey: effectiveStatus,
				repo: gitState.repo,
				branch: gitState.branch,
				prUrl: gitState.prUrl ?? branchMatch.prUrl,
				agent: "claude-code",
			});

			writeState(sessionId, {
				mode: "aligned",
				pendingPrompt: options.promptSeed,
				recentPrompts: options.recentPrompts,
				itemId: branchMatch.id,
				itemTitle: branchMatch.title,
				contentId: branchMatch.contentId,
				contentUrl: branchMatch.contentUrl,
				statusKey: effectiveStatus,
				repo: gitState.repo,
				repoFullName: gitState.repoFullName,
				branch: gitState.branch,
				baseHeadSha: gitState.headSha,
				prUrl: gitState.prUrl ?? branchMatch.prUrl,
				planningArtifactsAttachedAt: effectiveStatus === "planning" ? undefined : Date.now(),
				lastSyncAt: Date.now(),
				lastFinishCheckAt: undefined,
				lastError: undefined,
				lastErrorAt: undefined,
				retryCount: 0,
			});
			return true;
		}

		const title = generateSummary(options.promptSeed);
		const created = runWorker(cwd, {
			command: "createItem",
			title,
			body: buildIssueBody(options.recentPrompts, gitState),
			repoFullName: gitState.repoFullName,
			statusKey: options.desiredStatus,
			repo: gitState.repo,
			branch: gitState.branch,
			agent: "claude-code",
		});

		writeState(sessionId, {
			mode: "aligned",
			pendingPrompt: options.promptSeed,
			recentPrompts: options.recentPrompts,
			itemId: created.itemId,
			itemTitle: created.title,
			contentId: created.contentId,
			contentUrl: created.contentUrl,
			statusKey: options.desiredStatus,
			repo: gitState.repo,
			repoFullName: gitState.repoFullName,
			branch: gitState.branch,
			baseHeadSha: gitState.headSha,
			prUrl: gitState.prUrl,
			planningArtifactsAttachedAt: options.desiredStatus === "planning" ? undefined : Date.now(),
			lastSyncAt: Date.now(),
			lastFinishCheckAt: undefined,
			lastError: undefined,
			lastErrorAt: undefined,
			retryCount: 0,
		});
		return true;
	} catch (error) {
		if (options.preserveExisting && previousState.mode === "aligned") {
			writeState(sessionId, {
				...previousState,
				lastError: messageOf(error),
				lastErrorAt: Date.now(),
				retryCount: (previousState.retryCount ?? 0) + 1,
			});
		} else {
			writeState(sessionId, {
				...previousState,
				mode: "pending",
				pendingPrompt: options.promptSeed,
				recentPrompts: options.recentPrompts,
				lastError: messageOf(error),
				lastErrorAt: Date.now(),
				retryCount: (previousState.retryCount ?? 0) + 1,
			});
		}
		return false;
	}
}

async function recoverMissingItem(sessionId, cwd, config, state, nextStatus, extra = {}) {
	if (state.mode !== "aligned") return false;

	const gitState = extra.branch || extra.repo || extra.prUrl || extra.headSha
		? {
			repo: extra.repo ?? state.repo ?? "",
			repoFullName: extra.repoFullName ?? state.repoFullName,
			branch: extra.branch ?? state.branch ?? "",
			defaultBranch: extra.defaultBranch,
			headSha: extra.headSha ?? state.baseHeadSha,
			headMergedToDefault: extra.headMergedToDefault,
			prUrl: extra.prUrl ?? state.prUrl,
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
			itemId: branchMatch.id,
			itemTitle: branchMatch.title,
			contentId: branchMatch.contentId,
			contentUrl: branchMatch.contentUrl,
			statusKey: nextStatus,
			repo: gitState.repo ?? state.repo,
			repoFullName: gitState.repoFullName ?? state.repoFullName,
			branch: gitState.branch ?? state.branch,
			prUrl: gitState.prUrl ?? state.prUrl,
			lastSyncAt: Date.now(),
			lastError: undefined,
			lastErrorAt: undefined,
			retryCount: 0,
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
				itemId: readded.itemId,
				statusKey: nextStatus,
				repo: gitState.repo ?? state.repo,
				repoFullName: gitState.repoFullName ?? state.repoFullName,
				branch: gitState.branch ?? state.branch,
				prUrl: gitState.prUrl ?? state.prUrl,
				lastSyncAt: Date.now(),
				lastError: undefined,
				lastErrorAt: undefined,
				retryCount: 0,
			});
			return true;
		} catch {
			// Fall through.
		}
	}

	const promptSeed = getPromptSeed(state);
	const created = runWorker(cwd, {
		command: "createItem",
		title: state.itemTitle ?? generateSummary(promptSeed),
		body: buildIssueBody(state.recentPrompts ?? [promptSeed], gitState),
		repoFullName: gitState.repoFullName,
		statusKey: nextStatus,
		repo: gitState.repo ?? state.repo,
		branch: gitState.branch ?? state.branch,
		agent: "claude-code",
	});
	writeState(sessionId, {
		...state,
		itemId: created.itemId,
		itemTitle: created.title,
		contentId: created.contentId,
		contentUrl: created.contentUrl,
		statusKey: nextStatus,
		repo: gitState.repo ?? state.repo,
		repoFullName: gitState.repoFullName ?? state.repoFullName,
		branch: gitState.branch ?? state.branch,
		prUrl: gitState.prUrl ?? state.prUrl,
		lastSyncAt: Date.now(),
		lastError: undefined,
		lastErrorAt: undefined,
		retryCount: 0,
	});
	return true;
}

async function syncItem(sessionId, cwd, config, state, nextStatus, extra = {}) {
	if (state.mode !== "aligned" || !state.itemId) return;

	const itemId = state.itemId;
	const planningPrompts = [...(state.recentPrompts ?? [])];
	const issueUrl = state.contentUrl;
	const shouldAttachArtifacts =
		nextStatus === "inProgress" &&
		state.statusKey === "planning" &&
		!state.planningArtifactsAttachedAt &&
		Boolean(issueUrl) &&
		config.attachPlanningArtifacts;

	writeState(sessionId, {
		...state,
		statusKey: nextStatus,
		repo: extra.repo ?? state.repo,
		repoFullName: extra.repoFullName ?? state.repoFullName,
		branch: extra.branch ?? state.branch,
		prUrl: extra.prUrl ?? state.prUrl,
		lastSyncAt: Date.now(),
	});

	try {
		runWorker(cwd, {
			command: "updateItem",
			itemId,
			statusKey: nextStatus,
			repo: extra.repo ?? state.repo,
			branch: extra.branch ?? state.branch,
			prUrl: extra.prUrl ?? state.prUrl,
			agent: "claude-code",
		});

		if (shouldAttachArtifacts && issueUrl) {
			await attachPlanningArtifacts(sessionId, cwd, itemId, issueUrl, planningPrompts);
		}
		clearError(sessionId);
	} catch (error) {
		if (!isMissingItemError(error) || !(await recoverMissingItem(sessionId, cwd, config, readState(sessionId), nextStatus, extra))) {
			recordError(sessionId, readState(sessionId), error);
		}
	}
}

async function attachPlanningArtifacts(sessionId, cwd, itemId, issueUrl, prompts) {
	const artifacts = runWorker(cwd, { command: "planningArtifacts" });
	if (!artifacts.files?.length) {
		writeStateForItem(sessionId, itemId, { planningArtifactsAttachedAt: Date.now() });
		return;
	}

	runWorker(cwd, {
		command: "commentIssue",
		issueUrl,
		body: buildPlanningArtifactsComment(prompts, artifacts),
	});
	writeStateForItem(sessionId, itemId, { planningArtifactsAttachedAt: Date.now() });
}

async function checkForFinish(sessionId, cwd, config) {
	const state = readState(sessionId);
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

	const directToDefault =
		Boolean(gitState.defaultBranch) &&
		gitState.branch === gitState.defaultBranch &&
		Boolean(gitState.headSha) &&
		gitState.headSha !== state.baseHeadSha;
	const mergedFeatureBranch =
		Boolean(gitState.headMergedToDefault) &&
		Boolean(gitState.headSha) &&
		gitState.branch !== gitState.defaultBranch &&
		gitState.headSha !== state.baseHeadSha;

	if (!directToDefault && !mergedFeatureBranch) return;
	await syncItem(sessionId, cwd, config, readState(sessionId), "finished", gitState);
}

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

function writeStateForItem(sessionId, itemId, patch) {
	const state = readState(sessionId);
	if (state.itemId !== itemId) return;
	writeState(sessionId, { ...state, ...patch });
}

function statePath(sessionId) {
	return path.join(STATE_DIR, `${sessionId}.json`);
}

const CONFIG_FILE = ".coding-agents-alignment.json";

const DEFAULTS = {
	statusFieldName: "Status",
	statuses: { planning: "Planning", inProgress: "In Progress", finished: "Done" },
	attachPlanningArtifacts: true,
	finishCheckIntervalMs: 60_000,
};

function loadConfig(startDir) {
	const filePath = findConfigFile(startDir);
	const fileConfig = filePath ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};

	const githubOwner = process.env.CODING_AGENTS_ALIGNMENT_GITHUB_OWNER ?? fileConfig.githubOwner;
	const githubProjectNumber = Number(process.env.CODING_AGENTS_ALIGNMENT_GITHUB_PROJECT_NUMBER ?? fileConfig.githubProjectNumber);
	if (!githubOwner || !Number.isFinite(githubProjectNumber) || githubProjectNumber <= 0) return null;

	return {
		githubOwner,
		githubProjectNumber,
		repo: process.env.CODING_AGENTS_ALIGNMENT_REPO ?? fileConfig.repo,
		statusFieldName: process.env.CODING_AGENTS_ALIGNMENT_STATUS_FIELD ?? fileConfig.statusFieldName ?? DEFAULTS.statusFieldName,
		attachPlanningArtifacts:
			parseBoolean(process.env.CODING_AGENTS_ALIGNMENT_ATTACH_PLANNING_ARTIFACTS) ??
			fileConfig.attachPlanningArtifacts ??
			DEFAULTS.attachPlanningArtifacts,
		statuses: {
			planning:
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_PLANNING ??
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_TODO ??
				fileConfig.statuses?.planning ??
				fileConfig.statuses?.todo ??
				DEFAULTS.statuses.planning,
			inProgress:
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_IN_PROGRESS ?? fileConfig.statuses?.inProgress ?? DEFAULTS.statuses.inProgress,
			finished:
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_FINISHED ?? fileConfig.statuses?.finished ?? DEFAULTS.statuses.finished,
		},
		finishCheckIntervalMs: typeof fileConfig.finishCheckIntervalMs === "number" ? fileConfig.finishCheckIntervalMs : DEFAULTS.finishCheckIntervalMs,
	};
}

function statusLabelToKey(config, label) {
	if (!label) return undefined;
	if (label === config.statuses.planning) return "planning";
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

const LEADING_PHRASES = [
	/^please\s+/i,
	/^can you\s+/i,
	/^i have this idea[:\s-]*/i,
	/^let'?s\s+/i,
	/^we need to\s+/i,
	/^help me\s+/i,
];

const MAX_RECENT_PROMPTS = 8;
const SLASH_COMMAND_RE = /^\/\S+/;
const TASK_SWITCH_RE = /^(now|next|switch(?:ing)?|move on|separately|different task|another task|new task)\b/i;
const LIGHTWEIGHT_FOLLOW_UP_RE =
	/^(yes|yeah|yep|yup|ok|okay|sure|also|and|plus|pls|please|thanks|thx|do it|go ahead|continue|ship it|push( it)?|commit( it)?|release( it)?|tag( it)?|new tag as well|update docs|docs)$/i;

function generateSummary(prompt) {
	const singleLine = normalizePrompt(prompt);
	const firstSentence = singleLine.split(/[.!?]\s/)[0] ?? singleLine;
	let summary = firstSentence;
	for (const re of LEADING_PHRASES) summary = summary.replace(re, "");
	summary = summary.replace(/^to\s+/i, "").trim();
	if (!summary) summary = "Untitled work";
	if (summary.length > 72) summary = `${summary.slice(0, 69).trimEnd()}...`;
	return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function appendRecentPrompt(prompts, prompt) {
	const cleaned = normalizePrompt(prompt);
	if (!cleaned) return prompts ?? [];
	const next = [...(prompts ?? [])];
	if (next[next.length - 1] !== cleaned) next.push(cleaned);
	return next.slice(-MAX_RECENT_PROMPTS);
}

function inferPromptFromHistory(prompts) {
	const cleaned = (prompts ?? []).map(normalizePrompt).filter(Boolean);
	if (cleaned.length === 0) return undefined;
	for (let i = cleaned.length - 1; i >= 0; i -= 1) {
		const prompt = cleaned[i];
		if (SLASH_COMMAND_RE.test(prompt)) continue;
		if (!isLightweightFollowUp(prompt)) return prompt;
	}
	return cleaned.find((prompt) => !SLASH_COMMAND_RE.test(prompt));
}

function formatPlanningNotes(prompts) {
	return [...new Set((prompts ?? []).map(normalizePrompt).filter(Boolean).filter((prompt) => !SLASH_COMMAND_RE.test(prompt)))];
}

function isSubstantivePrompt(prompt) {
	const cleaned = normalizePrompt(prompt);
	if (!cleaned || SLASH_COMMAND_RE.test(cleaned)) return false;
	if (isLightweightFollowUp(cleaned)) return false;
	return cleaned.length >= 12;
}

function isLikelyTaskSwitch(prompt, currentTitle) {
	const cleaned = normalizePrompt(prompt);
	if (!isSubstantivePrompt(cleaned) || !currentTitle) return false;
	if (TASK_SWITCH_RE.test(cleaned)) return true;
	return similarityScore(generateSummary(cleaned), currentTitle) < 0.12;
}

function similarityScore(left, right) {
	const leftTokens = tokenize(left);
	const rightTokens = tokenize(right);
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
	const union = new Set([...leftTokens, ...rightTokens]).size;
	const jaccard = overlap / union;
	const leftLower = left.toLowerCase();
	const rightLower = right.toLowerCase();
	const substringBonus = leftLower.includes(rightLower) || rightLower.includes(leftLower) ? 0.2 : 0;
	return Math.min(1, jaccard + substringBonus);
}

function tokenize(value) {
	return new Set(
		value
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter((token) => token.length >= 3),
	);
}

function normalizePrompt(prompt) {
	return String(prompt ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

function isLightweightFollowUp(prompt) {
	return prompt.length <= 24 || LIGHTWEIGHT_FOLLOW_UP_RE.test(prompt);
}

function getPromptSeed(state) {
	return state.pendingPrompt?.trim() || inferPromptFromHistory(state.recentPrompts) || "Current session work";
}

function buildIssueBody(prompts, gitState) {
	const notes = formatPlanningNotes(prompts);
	const goal = notes[0] ?? "Current session work";
	return [
		"## Goal",
		goal,
		"",
		"## Constraints",
		"None captured yet.",
		"",
		"## Planning Notes",
		...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ["- None captured yet."]),
		"",
		"## Context",
		`- Repo: ${gitState.repo || "unknown"}`,
		`- Branch: ${gitState.branch || "unknown"}`,
		"- Agent: claude-code",
	].join("\n");
}

function buildPlanningArtifactsComment(prompts, artifacts) {
	const notes = formatPlanningNotes(prompts);
	const lines = [
		"## Planning Notes",
		...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ["- None captured."]),
		"",
		"## Planning Artifacts",
	];

	if (!artifacts.files?.length) {
		lines.push("- No changed Markdown artifacts were present at promotion time.");
		return lines.join("\n");
	}

	for (const artifact of artifacts.files) {
		lines.push(`- \`${artifact.path}\` [${artifact.status}]`);
		if (artifact.content) {
			lines.push("");
			lines.push(`<details><summary>${artifact.path}</summary>`);
			lines.push("");
			lines.push("```md");
			lines.push(artifact.content);
			if (artifact.contentTruncated) lines.push("\n<!-- truncated -->");
			lines.push("```");
			lines.push("</details>");
			lines.push("");
		}
	}

	return lines.join("\n");
}

function parseBoolean(value) {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

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
			const parsed = JSON.parse(stdout);
			if (!parsed.ok) throw new Error(parsed.error);
			return parsed.result;
		}
		throw new Error(stderr.trim() || messageOf(error));
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

function recordError(sessionId, state, error) {
	writeState(sessionId, {
		...state,
		lastError: messageOf(error),
		lastErrorAt: Date.now(),
		retryCount: (state.retryCount ?? 0) + 1,
	});
}

function clearError(sessionId) {
	const state = readState(sessionId);
	writeState(sessionId, {
		...state,
		lastError: undefined,
		lastErrorAt: undefined,
		retryCount: 0,
	});
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
