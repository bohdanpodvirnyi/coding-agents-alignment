import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadTrackerConfig, statusLabelToKey } from "./config.js";
import { generateSummary } from "./summary.js";
import { emptyTrackerState, loadTrackerState, persistTrackerState, type StatusKey, type TrackerState } from "./state.js";
import { runWorker, type GitState, type ProjectSnapshot } from "./worker-client.js";

export default function workTracker(pi: ExtensionAPI) {
	let state = emptyTrackerState();
	let creationInFlight = false;
	let backgroundQueue = Promise.resolve();

	// ── Helpers ──────────────────────────────────────────────────────────

	const reloadState = (ctx: ExtensionContext) => {
		state = loadTrackerState(ctx);
		updateStatusDisplay(ctx);
	};

	const saveState = (patch: Partial<TrackerState>) => {
		state = { ...state, ...patch };
		persistTrackerState(pi, state);
	};

	const enqueueBackground = (ctx: ExtensionContext, work: () => Promise<void>) => {
		backgroundQueue = backgroundQueue
			.then(work)
			.catch((error) => ctx.ui.notify(`tracking: ${messageOf(error)}`, "warning"));
	};

	const getConfig = (ctx: ExtensionContext) => {
		return loadTrackerConfig(ctx.cwd)?.config;
	};

	const updateStatusDisplay = (ctx: ExtensionContext) => {
		switch (state.mode) {
			case "pending":
				ctx.ui.setStatus("tracker", "📋 tracking…");
				break;
			case "tracked": {
				const icon = state.statusKey === "finished" ? "✓" : "●";
				ctx.ui.setStatus("tracker", `📋 ${icon} ${state.itemTitle ?? "tracked"}`);
				break;
			}
			default:
				ctx.ui.setStatus("tracker", undefined);
		}
	};

	// ── Core: create or link item on first code change ──────────────────

	const createOrLinkItem = async (ctx: ExtensionContext) => {
		const config = getConfig(ctx);
		if (!config) {
			creationInFlight = false;
			return;
		}

		try {
			const [gitState, snapshot] = await Promise.all([
				runWorker<GitState>(ctx.cwd, { command: "gitState" }),
				runWorker<ProjectSnapshot>(ctx.cwd, { command: "projectSnapshot" }),
			]);

			// Try branch-based match first
			const branchMatch = gitState.branch
				? snapshot.items.find((item) => item.branch === gitState.branch)
				: undefined;

			if (branchMatch) {
				const rawKey = statusLabelToKey(config, branchMatch.status) ?? "inProgress";
				const effectiveKey = rawKey === "todo" ? "inProgress" : rawKey;

				saveState({
					mode: "tracked",
					itemId: branchMatch.id,
					itemTitle: branchMatch.title,
					statusKey: effectiveKey,
					repo: gitState.repo,
					branch: gitState.branch,
					baseHeadSha: gitState.headSha,
					prUrl: gitState.prUrl ?? branchMatch.prUrl,
					lastSyncAt: Date.now(),
					pendingPrompt: undefined,
				});

				if (rawKey === "todo") {
					await runWorker(ctx.cwd, {
						command: "updateItem",
						itemId: branchMatch.id,
						statusKey: "inProgress",
						repo: gitState.repo,
						branch: gitState.branch,
						prUrl: gitState.prUrl ?? branchMatch.prUrl,
						agent: "pi",
					});
				}
			} else {
				const title = generateSummary(state.pendingPrompt ?? "Untitled work");
				const created = await runWorker<{ itemId: string; title: string }>(ctx.cwd, {
					command: "createItem",
					title,
					body: buildDraftBody(state.pendingPrompt ?? "", gitState),
					repoFullName: gitState.repoFullName,
					statusKey: "inProgress",
					repo: gitState.repo,
					branch: gitState.branch,
					agent: "pi",
				});

				saveState({
					mode: "tracked",
					itemId: created.itemId,
					itemTitle: created.title,
					statusKey: "inProgress",
					repo: gitState.repo,
					branch: gitState.branch,
					baseHeadSha: gitState.headSha,
					prUrl: gitState.prUrl,
					lastSyncAt: Date.now(),
					pendingPrompt: undefined,
				});
			}

			updateStatusDisplay(ctx);
		} catch (error) {
			saveState({ mode: "idle", pendingPrompt: undefined });
			updateStatusDisplay(ctx);
			ctx.ui.notify(`tracking failed: ${messageOf(error)}`, "warning");
		} finally {
			creationInFlight = false;
		}
	};

	// ── Sync helpers ────────────────────────────────────────────────────

	const syncTrackedItem = (ctx: ExtensionContext, nextStatus: StatusKey, extra: Partial<GitState> = {}) => {
		if (state.mode !== "tracked" || !state.itemId) return;
		const config = getConfig(ctx);
		if (!config) return;
		const itemId = state.itemId;

		saveState({
			statusKey: nextStatus,
			branch: extra.branch ?? state.branch,
			repo: extra.repo ?? state.repo,
			prUrl: extra.prUrl ?? state.prUrl,
			lastSyncAt: Date.now(),
		});
		updateStatusDisplay(ctx);

		enqueueBackground(ctx, async () => {
			const latestGit =
				extra.branch || extra.repo || extra.prUrl
					? undefined
					: await runWorker<GitState>(ctx.cwd, { command: "gitState" });
			await runWorker(ctx.cwd, {
				command: "updateItem",
				itemId,
				statusKey: nextStatus,
				repo: extra.repo ?? latestGit?.repo ?? state.repo,
				branch: extra.branch ?? latestGit?.branch ?? state.branch,
				prUrl: extra.prUrl ?? latestGit?.prUrl ?? state.prUrl,
				agent: "pi",
			});
		});
	};

	const checkForFinish = (ctx: ExtensionContext) => {
		if (state.mode !== "tracked" || state.statusKey === "finished" || !state.itemId) return;
		const config = getConfig(ctx);
		if (!config) return;
		const now = Date.now();
		if (state.lastFinishCheckAt && now - state.lastFinishCheckAt < config.finishCheckIntervalMs) return;
		saveState({ lastFinishCheckAt: now });

		enqueueBackground(ctx, async () => {
			const gitState = await runWorker<GitState>(ctx.cwd, { command: "gitState" });
			const committedToDefault =
				Boolean(gitState.defaultBranch) &&
				gitState.branch === gitState.defaultBranch &&
				Boolean(gitState.headSha) &&
				gitState.headSha !== state.baseHeadSha;
			if (!gitState.prUrl && !committedToDefault) return;
			syncTrackedItem(ctx, "finished", gitState);
		});
	};

	// ── Session lifecycle ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => reloadState(ctx));
	pi.on("session_switch", async (_event, ctx) => reloadState(ctx));
	pi.on("session_fork", async (_event, ctx) => reloadState(ctx));
	pi.on("session_tree", async (_event, ctx) => reloadState(ctx));

	// ── Automatic tracking ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!getConfig(ctx)) return;
		if (state.mode === "idle") {
			saveState({ mode: "pending", pendingPrompt: event.prompt });
			updateStatusDisplay(ctx);
		} else if (state.mode === "pending") {
			// Keep the latest prompt for a better title
			saveState({ pendingPrompt: event.prompt });
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			if (state.mode === "pending" && !creationInFlight) {
				creationInFlight = true;
				enqueueBackground(ctx, () => createOrLinkItem(ctx));
			} else if (state.mode === "tracked" && state.statusKey === "todo") {
				syncTrackedItem(ctx, "inProgress");
			}
		}
		if (event.toolName === "bash" && !event.isError) {
			checkForFinish(ctx);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		checkForFinish(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await backgroundQueue;
	});

	// ── Commands (manual overrides only) ────────────────────────────────

	pi.registerCommand("track", {
		description: "Re-enable automatic tracking after /track-unlink",
		handler: async (_args, ctx) => {
			if (state.mode === "unlinked") {
				saveState({ mode: "idle", pendingPrompt: undefined });
				updateStatusDisplay(ctx);
				ctx.ui.notify("tracking re-enabled", "info");
			} else if (state.mode === "tracked") {
				ctx.ui.notify(`already tracking: ${state.itemTitle}`, "info");
			} else {
				ctx.ui.notify(`tracking: ${state.mode}`, "info");
			}
		},
	});

	pi.registerCommand("track-status", {
		description: "Show current tracking state",
		handler: async (_args, ctx) => {
			if (state.mode === "tracked") {
				ctx.ui.notify(
					`📋 ${state.itemTitle ?? state.itemId} [${state.statusKey}]${state.prUrl ? ` ${state.prUrl}` : ""}`,
					"info",
				);
			} else {
				ctx.ui.notify(`tracking: ${state.mode}`, "info");
			}
		},
	});

	pi.registerCommand("track-finish", {
		description: "Force tracked item to Done",
		handler: async (_args, ctx) => {
			if (state.mode !== "tracked") {
				ctx.ui.notify("no tracked item", "warning");
				return;
			}
			syncTrackedItem(ctx, "finished");
		},
	});

	pi.registerCommand("track-unlink", {
		description: "Stop tracking for this session",
		handler: async (_args, ctx) => {
			saveState({ mode: "unlinked", pendingPrompt: undefined });
			updateStatusDisplay(ctx);
			ctx.ui.notify("tracking stopped", "info");
		},
	});

	pi.registerCommand("track-resync", {
		description: "Re-sync tracked item with GitHub",
		handler: async (_args, ctx) => {
			if (state.mode !== "tracked" || !state.itemId) {
				ctx.ui.notify("no tracked item to resync", "warning");
				return;
			}
			enqueueBackground(ctx, async () => {
				const gitState = await runWorker<GitState>(ctx.cwd, { command: "gitState" });
				await runWorker(ctx.cwd, {
					command: "updateItem",
					itemId: state.itemId,
					statusKey: state.statusKey ?? "inProgress",
					repo: gitState.repo,
					branch: gitState.branch,
					prUrl: gitState.prUrl,
					agent: "pi",
				});
				ctx.ui.notify("tracking resynced", "info");
			});
		},
	});
}

// ── Utilities ───────────────────────────────────────────────────────────

function buildDraftBody(prompt: string, gitState: GitState): string {
	const excerpt = prompt.replace(/\s+/g, " ").trim().slice(0, 500);
	return [
		"Created by pi-agents-alignment",
		`Created at: ${new Date().toISOString()}`,
		`Repo: ${gitState.repo}`,
		`Branch: ${gitState.branch}`,
		"",
		"Prompt excerpt:",
		excerpt,
	].join("\n");
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
