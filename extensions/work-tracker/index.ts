import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadTrackerConfig, statusLabelToKey } from "./config.js";
import { generateSummary, rankSimilarItems } from "./summary.js";
import { emptyTrackerState, loadTrackerState, persistTrackerState, type StatusKey, type TrackerState } from "./state.js";
import { runWorker, type GitState, type ProjectItemSummary, type ProjectSnapshot } from "./worker-client.js";

const PROMPT_OPTIONS = [
	"Create new tracked item",
	"Link existing item",
	"Skip for this session",
] as const;

export default function workTracker(pi: ExtensionAPI) {
	let state = emptyTrackerState();
	let enrollmentInFlight = false;
	let backgroundQueue = Promise.resolve();

	const reloadState = (ctx: ExtensionContext) => {
		state = loadTrackerState(ctx);
	};

	const saveState = (patch: Partial<TrackerState>) => {
		state = { ...state, ...patch };
		persistTrackerState(pi, state);
	};

	const resetState = () => {
		state = emptyTrackerState();
		persistTrackerState(pi, state);
	};

	const enqueueBackground = (ctx: ExtensionContext, work: () => Promise<void>) => {
		backgroundQueue = backgroundQueue
			.then(work)
			.catch((error) => ctx.ui.notify(`tracking sync failed: ${messageOf(error)}`, "warning"));
	};

	const getConfig = (ctx: ExtensionContext, noisy = false) => {
		const loaded = loadTrackerConfig(ctx.cwd);
		if (!loaded && noisy) ctx.ui.notify("pi-agents-alignment not configured in this repo", "warning");
		return loaded?.config;
	};

	const getOpenItems = (config: NonNullable<ReturnType<typeof getConfig>>, snapshot: ProjectSnapshot) =>
		snapshot.items.filter((item) => {
			const key = statusLabelToKey(config, item.status);
			return key === "todo" || key === "inProgress";
		});

	const selectExistingItem = async (ctx: ExtensionContext, items: ProjectItemSummary[]) => {
		if (items.length === 0) {
			ctx.ui.notify("No open tracked items found", "info");
			return undefined;
		}
		const candidates = items.slice(0, 20);
		const labels = candidates.map((item) => `${item.title}${item.status ? ` — ${item.status}` : ""}`);
		const picked = await ctx.ui.select("Link existing tracked item", labels);
		if (!picked) return undefined;
		return candidates[labels.indexOf(picked)];
	};

	const attachTrackedItem = (ctx: ExtensionContext, config: NonNullable<ReturnType<typeof getConfig>>, item: ProjectItemSummary, gitState?: GitState) => {
		saveState({
			mode: "tracked",
			itemId: item.id,
			itemTitle: item.title,
			statusKey: statusLabelToKey(config, item.status) ?? "todo",
			repo: gitState?.repo ?? state.repo,
			branch: gitState?.branch ?? item.branch ?? state.branch,
			baseHeadSha: gitState?.headSha ?? state.baseHeadSha,
			prUrl: gitState?.prUrl ?? item.prUrl,
			lastSyncAt: Date.now(),
		});
		ctx.ui.notify(`tracking: ${item.title}`, "info");
	};

	const promptForTracking = async (ctx: ExtensionContext, prompt: string, force = false) => {
		if (enrollmentInFlight) return;
		if (!force && state.mode !== "idle") return;
		const config = getConfig(ctx, force);
		if (!config) return;
		enrollmentInFlight = true;
		try {
			const action = await ctx.ui.select("Track this in GitHub Project?", [...PROMPT_OPTIONS]);
			if (!action) return;
			if (action === "Skip for this session") {
				saveState({ mode: "skipped" });
				return;
			}
			const [snapshot, gitState] = await Promise.all([
				runWorker<ProjectSnapshot>(ctx.cwd, { command: "projectSnapshot" }),
				runWorker<GitState>(ctx.cwd, { command: "gitState" }),
			]);
			if (action === "Link existing item") {
				const item = await selectExistingItem(ctx, getOpenItems(config, snapshot));
				if (!item) return;
				attachTrackedItem(ctx, config, item, gitState);
				return;
			}
			const generatedTitle = generateSummary(prompt);
			const editedTitle = (await ctx.ui.editor("Edit tracked item title", generatedTitle))?.trim() || generatedTitle;
			const similar = rankSimilarItems(editedTitle, getOpenItems(config, snapshot));
			if (similar.length > 0) {
				const options = [
					`Create new: ${editedTitle}`,
					...similar.map((item) => `Link existing: ${item.title} (${Math.round(item.score * 100)}%)`),
				];
				const overlapChoice = await ctx.ui.select("Possible overlap found", options);
				if (!overlapChoice) return;
				if (overlapChoice !== options[0]) {
					const existing = similar[options.indexOf(overlapChoice) - 1];
					attachTrackedItem(ctx, config, existing, gitState);
					return;
				}
			}
			const created = await runWorker<{ itemId: string; title: string }>(ctx.cwd, {
				command: "createItem",
				title: editedTitle,
				body: buildDraftBody(prompt, gitState),
				statusKey: "todo",
				repo: gitState.repo,
				branch: gitState.branch,
				agent: "pi",
			});
			attachTrackedItem(
				ctx,
				config,
				{ id: created.itemId, title: created.title, status: config.statuses.todo, branch: gitState.branch },
				gitState,
			);
		} catch (error) {
			ctx.ui.notify(`tracking failed: ${messageOf(error)}`, "warning");
		} finally {
			enrollmentInFlight = false;
		}
	};

	const syncTrackedItem = (ctx: ExtensionContext, nextStatus: StatusKey, extra: Partial<GitState> = {}, notify = true) => {
		if (state.mode !== "tracked" || !state.itemId) return;
		const config = getConfig(ctx);
		if (!config) return;
		const itemId = state.itemId;
		const nextState: Partial<TrackerState> = {
			statusKey: nextStatus,
			branch: extra.branch ?? state.branch,
			repo: extra.repo ?? state.repo,
			prUrl: extra.prUrl ?? state.prUrl,
			lastSyncAt: Date.now(),
		};
		saveState(nextState);
		enqueueBackground(ctx, async () => {
			const latestGitState = extra.branch || extra.repo || extra.prUrl ? undefined : await runWorker<GitState>(ctx.cwd, { command: "gitState" });
			await runWorker(ctx.cwd, {
				command: "updateItem",
				itemId,
				statusKey: nextStatus,
				repo: extra.repo ?? latestGitState?.repo ?? state.repo,
				branch: extra.branch ?? latestGitState?.branch ?? state.branch,
				prUrl: extra.prUrl ?? latestGitState?.prUrl ?? state.prUrl,
				agent: "pi",
			});
			if (notify) ctx.ui.notify(`tracking synced: ${config.statuses[nextStatus]}`, "info");
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
			const committedToDefaultBranch =
				Boolean(gitState.defaultBranch) &&
				gitState.branch === gitState.defaultBranch &&
				Boolean(gitState.headSha) &&
				gitState.headSha !== state.baseHeadSha;
			if (!gitState.prUrl && !committedToDefaultBranch) return;
			syncTrackedItem(ctx, "finished", gitState);
		});
	};

	pi.on("session_start", async (_event, ctx) => reloadState(ctx));
	pi.on("session_switch", async (_event, ctx) => reloadState(ctx));
	pi.on("session_fork", async (_event, ctx) => reloadState(ctx));
	pi.on("session_tree", async (_event, ctx) => reloadState(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		const config = getConfig(ctx);
		if (!config) return;
		if (state.mode !== "idle") return;
		if (!looksLikeDurableWork(event.prompt, config.askKeywords)) return;
		await promptForTracking(ctx, event.prompt);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError && state.statusKey === "todo") {
			syncTrackedItem(ctx, "inProgress");
		}
		if (event.toolName === "bash" && !event.isError) checkForFinish(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		checkForFinish(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await backgroundQueue;
	});

	pi.registerCommand("track", {
		description: "Create or link a GitHub Project item for this session",
		handler: async (_args, ctx) => {
			await promptForTracking(ctx, "Manual tracking request", true);
		},
	});

	pi.registerCommand("track-status", {
		description: "Show current tracked item state",
		handler: async (_args, ctx) => {
			if (state.mode !== "tracked") {
				ctx.ui.notify(`tracking: ${state.mode}`, "info");
				return;
			}
			ctx.ui.notify(
				`tracking: ${state.itemTitle ?? state.itemId} [${state.statusKey ?? "unknown"}]${state.prUrl ? ` ${state.prUrl}` : ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("track-finish", {
		description: "Force current tracked item to Finished",
		handler: async (_args, ctx) => {
			syncTrackedItem(ctx, "finished");
		},
	});

	pi.registerCommand("track-unlink", {
		description: "Detach the current session from tracked work",
		handler: async (_args, ctx) => {
			resetState();
			ctx.ui.notify("tracking unlinked", "info");
		},
	});

	pi.registerCommand("track-resync", {
		description: "Re-run GitHub sync for the tracked item",
		handler: async (_args, ctx) => {
			if (state.mode !== "tracked" || !state.itemId) {
				ctx.ui.notify("no tracked item", "warning");
				return;
			}
			enqueueBackground(ctx, async () => {
				const gitState = await runWorker<GitState>(ctx.cwd, { command: "gitState" });
				await runWorker(ctx.cwd, {
					command: "updateItem",
					itemId: state.itemId,
					statusKey: state.statusKey ?? "todo",
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

function looksLikeDurableWork(prompt: string, keywords: string[]): boolean {
	const lower = prompt.toLowerCase();
	if (lower.length < 20) return false;
	return keywords.some((keyword) => lower.includes(keyword));
}

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
