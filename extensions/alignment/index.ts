import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadAlignmentConfig, statusLabelToKey, type AlignmentConfig } from "./config.js";
import {
	appendRecentPrompt,
	formatPlanningNotes,
	generateSummary,
	inferPromptFromHistory,
	isLikelyTaskSwitch,
	isSubstantivePrompt,
} from "./summary.js";
import { emptyState, loadState, persistState, type StatusKey, type AlignmentState } from "./state.js";
import { runWorker, type GitState, type PlanningArtifactsSnapshot, type ProjectSnapshot } from "./worker-client.js";

export default function alignment(pi: ExtensionAPI) {
	let state = emptyState();
	let creationInFlight = false;
	let backgroundQueue = Promise.resolve();

	const reloadState = (ctx: ExtensionContext) => {
		state = loadState(ctx);
		updateStatus(ctx);
	};

	const saveState = (patch: Partial<AlignmentState>) => {
		state = { ...state, ...patch };
		persistState(pi, state);
	};

	const replaceState = (nextState: AlignmentState) => {
		state = nextState;
		persistState(pi, state);
	};

	const saveStateForItem = (itemId: string | undefined, patch: Partial<AlignmentState>) => {
		if (!itemId || state.itemId !== itemId) return;
		saveState(patch);
	};

	const getConfig = (ctx: ExtensionContext) => loadAlignmentConfig(ctx.cwd)?.config;

	const updateStatus = (ctx: ExtensionContext) => {
		const config = getConfig(ctx);
		if (!config || config.visibility === "silent") {
			ctx.ui.setStatus("alignment", undefined);
			return;
		}

		switch (state.mode) {
			case "pending":
				ctx.ui.setStatus("alignment", "📋 planning…");
				break;
			case "aligned": {
				const icon = state.statusKey === "finished" ? "✓" : state.statusKey === "planning" ? "◌" : "●";
				ctx.ui.setStatus("alignment", `📋 ${icon} ${state.itemTitle ?? "aligned"}`);
				break;
			}
			default:
				ctx.ui.setStatus("alignment", undefined);
		}
	};

	const ambientNotify = (
		ctx: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error" = "info",
		requiredVisibility: AlignmentConfig["visibility"] = "verbose",
	) => {
		const config = getConfig(ctx);
		if (!config || config.visibility === "silent") return;
		if (requiredVisibility === "verbose" && config.visibility !== "verbose") return;
		ctx.ui.notify(message, level);
	};

	const recordError = (ctx: ExtensionContext, error: unknown) => {
		saveState({
			lastError: messageOf(error),
			lastErrorAt: Date.now(),
			retryCount: (state.retryCount ?? 0) + 1,
		});
		ambientNotify(ctx, `alignment: ${messageOf(error)}`, "warning");
	};

	const clearError = () => {
		saveState({ lastError: undefined, lastErrorAt: undefined, retryCount: 0 });
	};

	const enqueueBackground = (ctx: ExtensionContext, work: () => Promise<void>) => {
		backgroundQueue = backgroundQueue.then(work).catch((error) => recordError(ctx, error));
	};

	const inferPromptSeed = () => state.pendingPrompt || inferPromptFromHistory(state.recentPrompts) || "Current session work";

	const buildIssueBody = (prompts: string[], gitState: GitState) => {
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
			"- Agent: pi",
		].join("\n");
	};

	const createOrLinkItem = async (ctx: ExtensionContext, options: {
		promptSeed: string;
		recentPrompts: string[];
		desiredStatus: StatusKey;
		preserveExisting: boolean;
	}) => {
		const config = getConfig(ctx);
		if (!config) {
			creationInFlight = false;
			return false;
		}

		const previousState = state;

		try {
			const [gitState, snapshot] = await Promise.all([
				runWorker<GitState>(ctx.cwd, { command: "gitState" }),
				runWorker<ProjectSnapshot>(ctx.cwd, { command: "projectSnapshot" }),
			]);

			const branchMatch = gitState.branch ? snapshot.items.find((item) => item.branch === gitState.branch) : undefined;

			if (branchMatch) {
				const effectiveStatus = statusLabelToKey(config, branchMatch.status) ?? options.desiredStatus;
				await runWorker(ctx.cwd, {
					command: "updateItem",
					itemId: branchMatch.id,
					statusKey: effectiveStatus,
					repo: gitState.repo,
					branch: gitState.branch,
					prUrl: gitState.prUrl ?? branchMatch.prUrl,
					agent: "pi",
				});

				replaceState({
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
			} else {
				const title = generateSummary(options.promptSeed);
				const created = await runWorker<{ itemId: string; title: string; contentId?: string; contentUrl?: string }>(ctx.cwd, {
					command: "createItem",
					title,
					body: buildIssueBody(options.recentPrompts, gitState),
					repoFullName: gitState.repoFullName,
					statusKey: options.desiredStatus,
					repo: gitState.repo,
					branch: gitState.branch,
					agent: "pi",
				});

				replaceState({
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
			}

			updateStatus(ctx);
			return true;
		} catch (error) {
			if (options.preserveExisting && previousState.mode === "aligned") {
				replaceState({
					...previousState,
					lastError: messageOf(error),
					lastErrorAt: Date.now(),
					retryCount: (previousState.retryCount ?? 0) + 1,
				});
			} else {
				replaceState({
					...previousState,
					mode: "pending",
					pendingPrompt: options.promptSeed,
					recentPrompts: options.recentPrompts,
					lastError: messageOf(error),
					lastErrorAt: Date.now(),
					retryCount: (previousState.retryCount ?? 0) + 1,
				});
			}
			updateStatus(ctx);
			return false;
		} finally {
			creationInFlight = false;
		}
	};

	const isMissingItemError = (error: unknown) => {
		const message = messageOf(error).toLowerCase();
		return (
			message.includes("projectv2item") ||
			message.includes("could not resolve") ||
			message.includes("not found") ||
			message.includes("does not exist")
		);
	};

	const recoverMissingItem = async (ctx: ExtensionContext, nextStatus: StatusKey, extra: Partial<GitState> = {}) => {
		if (state.mode !== "aligned") return false;
		const config = getConfig(ctx);
		if (!config) return false;

		const gitState = extra.branch || extra.repo || extra.prUrl || extra.headSha
			? ({
				repo: extra.repo ?? state.repo ?? "",
				repoFullName: extra.repoFullName ?? state.repoFullName,
				branch: extra.branch ?? state.branch ?? "",
				defaultBranch: extra.defaultBranch,
				headSha: extra.headSha ?? state.baseHeadSha,
				headMergedToDefault: extra.headMergedToDefault,
				prUrl: extra.prUrl ?? state.prUrl,
			} satisfies Partial<GitState>)
			: await runWorker<GitState>(ctx.cwd, { command: "gitState" });
		const snapshot = await runWorker<ProjectSnapshot>(ctx.cwd, { command: "projectSnapshot" });
		const branchMatch = gitState.branch ? snapshot.items.find((item) => item.branch === gitState.branch) : undefined;

		if (branchMatch) {
			await runWorker(ctx.cwd, {
				command: "updateItem",
				itemId: branchMatch.id,
				statusKey: nextStatus,
				repo: gitState.repo ?? state.repo,
				branch: gitState.branch ?? state.branch,
				prUrl: gitState.prUrl ?? state.prUrl,
				agent: "pi",
			});
			saveState({
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
			});
			clearError();
			updateStatus(ctx);
			return true;
		}

		if (state.contentId) {
			try {
				const readded = await runWorker<{ itemId: string }>(ctx.cwd, {
					command: "addItemByContentId",
					contentId: state.contentId,
					statusKey: nextStatus,
					repo: gitState.repo ?? state.repo,
					branch: gitState.branch ?? state.branch,
					prUrl: gitState.prUrl ?? state.prUrl,
					agent: "pi",
				});
				saveState({
					itemId: readded.itemId,
					statusKey: nextStatus,
					repo: gitState.repo ?? state.repo,
					repoFullName: gitState.repoFullName ?? state.repoFullName,
					branch: gitState.branch ?? state.branch,
					prUrl: gitState.prUrl ?? state.prUrl,
					lastSyncAt: Date.now(),
				});
				clearError();
				updateStatus(ctx);
				return true;
			} catch {
				// Fall through to recreation.
			}
		}

		const promptSeed = inferPromptSeed();
		const title = state.itemTitle ?? generateSummary(promptSeed);
		const created = await runWorker<{ itemId: string; title: string; contentId?: string; contentUrl?: string }>(ctx.cwd, {
			command: "createItem",
			title,
			body: buildIssueBody(state.recentPrompts ?? [promptSeed], gitState as GitState),
			repoFullName: (gitState as GitState).repoFullName,
			statusKey: nextStatus,
			repo: gitState.repo ?? state.repo,
			branch: gitState.branch ?? state.branch,
			agent: "pi",
		});
		saveState({
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
		});
		clearError();
		updateStatus(ctx);
		return true;
	};

	const buildPlanningArtifactsComment = (prompts: string[], artifacts: PlanningArtifactsSnapshot) => {
		const notes = formatPlanningNotes(prompts);
		const lines = [
			"## Planning Notes",
			...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ["- None captured."]),
			"",
			"## Planning Artifacts",
		];

		if (artifacts.files.length === 0) {
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
	};

	const attachPlanningArtifacts = async (
		ctx: ExtensionContext,
		itemId: string,
		issueUrl: string,
		prompts: string[],
	) => {
		const config = getConfig(ctx);
		if (!config || !config.attachPlanningArtifacts) return;
		if (state.planningArtifactsAttachedAt) return;

		const artifacts = await runWorker<PlanningArtifactsSnapshot>(ctx.cwd, { command: "planningArtifacts" });
		if (artifacts.files.length === 0) {
			saveStateForItem(itemId, { planningArtifactsAttachedAt: Date.now() });
			return;
		}

		await runWorker(ctx.cwd, {
			command: "commentIssue",
			issueUrl,
			body: buildPlanningArtifactsComment(prompts, artifacts),
		});
		saveStateForItem(itemId, { planningArtifactsAttachedAt: Date.now() });
	};

	const syncItem = (ctx: ExtensionContext, nextStatus: StatusKey, extra: Partial<GitState> = {}) => {
		if (state.mode !== "aligned" || !state.itemId) return;
		const config = getConfig(ctx);
		if (!config) return;

		const itemId = state.itemId;
		const planningPrompts = [...(state.recentPrompts ?? [])];
		const issueUrl = state.contentUrl;
		const shouldAttachArtifacts =
			nextStatus === "inProgress" &&
			state.statusKey === "planning" &&
			!state.planningArtifactsAttachedAt &&
			Boolean(issueUrl);

		saveState({
			statusKey: nextStatus,
			branch: extra.branch ?? state.branch,
			repo: extra.repo ?? state.repo,
			repoFullName: extra.repoFullName ?? state.repoFullName,
			prUrl: extra.prUrl ?? state.prUrl,
			lastSyncAt: Date.now(),
		});
		updateStatus(ctx);

		enqueueBackground(ctx, async () => {
			const latestGit =
				extra.branch || extra.repo || extra.prUrl || extra.headSha
					? undefined
					: await runWorker<GitState>(ctx.cwd, { command: "gitState" });

			try {
				await runWorker(ctx.cwd, {
					command: "updateItem",
					itemId,
					statusKey: nextStatus,
					repo: extra.repo ?? latestGit?.repo ?? state.repo,
					branch: extra.branch ?? latestGit?.branch ?? state.branch,
					prUrl: extra.prUrl ?? latestGit?.prUrl ?? state.prUrl,
					agent: "pi",
				});

					if (shouldAttachArtifacts && issueUrl) {
						await attachPlanningArtifacts(ctx, itemId, issueUrl, planningPrompts);
					}
				clearError();
			} catch (error) {
				if (!isMissingItemError(error)) throw error;
				await recoverMissingItem(ctx, nextStatus, latestGit ?? extra);
			}
		});
	};

	const checkForFinish = (ctx: ExtensionContext) => {
		if (state.mode !== "aligned" || state.statusKey === "finished" || !state.itemId) return;
		const config = getConfig(ctx);
		if (!config) return;
		const now = Date.now();
		if (state.lastFinishCheckAt && now - state.lastFinishCheckAt < config.finishCheckIntervalMs) return;
		saveState({ lastFinishCheckAt: now });

		enqueueBackground(ctx, async () => {
			const gitState = await runWorker<GitState>(ctx.cwd, { command: "gitState" });
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
			syncItem(ctx, "finished", gitState);
		});
	};

	const startTrackingPrompt = (ctx: ExtensionContext, prompt: string, preserveExisting: boolean) => {
		const recentPrompts = appendRecentPrompt(undefined, prompt);
		if (!preserveExisting) {
			saveState({
				mode: "pending",
				pendingPrompt: prompt,
				recentPrompts,
				planningArtifactsAttachedAt: undefined,
			});
			updateStatus(ctx);
		}
			if (creationInFlight) return;
			creationInFlight = true;
			enqueueBackground(ctx, async () => {
				await createOrLinkItem(ctx, {
					promptSeed: prompt,
					recentPrompts,
					desiredStatus: "planning",
					preserveExisting,
				});
			});
		};

	pi.on("session_start", async (_event, ctx) => reloadState(ctx));
	pi.on("session_switch", async (_event, ctx) => reloadState(ctx));
	pi.on("session_fork", async (_event, ctx) => reloadState(ctx));
	pi.on("session_tree", async (_event, ctx) => reloadState(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (state.mode === "unlinked" || !getConfig(ctx)) return;
		const prompt = event.prompt ?? "";
		if (!isSubstantivePrompt(prompt)) return;

		if (state.mode === "idle" || state.mode === "pending") {
			startTrackingPrompt(ctx, prompt, false);
			return;
		}

		if (state.mode === "aligned" && isLikelyTaskSwitch(prompt, state.itemTitle)) {
			startTrackingPrompt(ctx, prompt, true);
			return;
		}

		saveState({
			pendingPrompt: prompt,
			recentPrompts: appendRecentPrompt(state.recentPrompts, prompt),
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			if (state.mode === "pending" && !creationInFlight) {
				creationInFlight = true;
				enqueueBackground(ctx, async () => {
					const created = await createOrLinkItem(ctx, {
						promptSeed: inferPromptSeed(),
						recentPrompts: state.recentPrompts ?? [inferPromptSeed()],
						desiredStatus: "planning",
						preserveExisting: false,
					});
					if (created && state.mode === "aligned" && state.statusKey === "planning") {
						syncItem(ctx, "inProgress");
					}
				});
			} else if (state.mode === "aligned" && state.statusKey === "planning") {
				syncItem(ctx, "inProgress");
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

	pi.registerCommand("align", {
		description: "Re-enable alignment, or start tracking current work now",
		handler: async (args, ctx) => {
			if (!getConfig(ctx)) {
				ctx.ui.notify("alignment not configured", "warning");
				return;
			}
			if (creationInFlight) {
				ctx.ui.notify("alignment already starting", "info");
				return;
			}

			const prompt = args.trim() || inferPromptSeed();
			startTrackingPrompt(ctx, prompt, false);
			ctx.ui.notify("alignment starting", "info");
		},
	});

	pi.registerCommand("align-status", {
		description: "Show current alignment state",
		handler: async (_args, ctx) => {
			if (state.mode === "aligned") {
				const detail = [`📋 ${state.itemTitle ?? state.itemId} [${state.statusKey}]`];
				if (state.prUrl) detail.push(state.prUrl);
				if (state.lastError) detail.push(`error: ${state.lastError}`);
				ctx.ui.notify(detail.join(" "), "info");
			} else if (state.lastError) {
				ctx.ui.notify(`alignment: ${state.mode} (last error: ${state.lastError})`, "info");
			} else {
				ctx.ui.notify(`alignment: ${state.mode}`, "info");
			}
		},
	});

	pi.registerCommand("align-finish", {
		description: "Force aligned item to Done",
		handler: async (_args, ctx) => {
			if (state.mode !== "aligned") {
				ctx.ui.notify("no aligned item", "warning");
				return;
			}
			syncItem(ctx, "finished");
			ctx.ui.notify("marked as done", "info");
		},
	});

	pi.registerCommand("align-unlink", {
		description: "Stop alignment for this session",
		handler: async (_args, ctx) => {
			saveState({ mode: "unlinked" });
			updateStatus(ctx);
			ctx.ui.notify("alignment stopped", "info");
		},
	});

	pi.registerCommand("align-resync", {
		description: "Re-sync aligned item with GitHub",
		handler: async (_args, ctx) => {
			if (state.mode !== "aligned" || !state.itemId) {
				ctx.ui.notify("no aligned item to resync", "warning");
				return;
			}
			enqueueBackground(ctx, async () => {
				const gitState = await runWorker<GitState>(ctx.cwd, { command: "gitState" });
				try {
					await runWorker(ctx.cwd, {
						command: "updateItem",
						itemId: state.itemId,
						statusKey: state.statusKey ?? "inProgress",
						repo: gitState.repo,
						branch: gitState.branch,
						prUrl: gitState.prUrl,
						agent: "pi",
					});
					clearError();
					ctx.ui.notify("alignment synced", "info");
				} catch (error) {
					if (!isMissingItemError(error) || !(await recoverMissingItem(ctx, state.statusKey ?? "inProgress", gitState))) {
						throw error;
					}
					ctx.ui.notify("alignment recovered and synced", "info");
				}
			});
		},
	});
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
