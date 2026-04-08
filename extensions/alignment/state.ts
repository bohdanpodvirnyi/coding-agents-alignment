import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type StatusKey = "planning" | "inProgress" | "finished";
export type AlignmentMode = "idle" | "pending" | "aligned" | "unlinked";

export interface AlignmentState {
	mode: AlignmentMode;
	pendingPrompt?: string;
	recentPrompts?: string[];
	itemId?: string;
	itemTitle?: string;
	contentId?: string;
	contentUrl?: string;
	statusKey?: StatusKey;
	repo?: string;
	repoFullName?: string;
	branch?: string;
	baseHeadSha?: string;
	prUrl?: string;
	planningArtifactsAttachedAt?: number;
	lastSyncAt?: number;
	lastFinishCheckAt?: number;
	lastError?: string;
	lastErrorAt?: number;
	retryCount?: number;
}

const CUSTOM_TYPE = "coding-agents-alignment-state";

export function emptyState(): AlignmentState {
	return { mode: "idle" };
}

export function loadState(ctx: ExtensionContext): AlignmentState {
	let current = emptyState();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		current = { ...current, ...(entry.data as Partial<AlignmentState>) };
	}
	return current;
}

export function persistState(pi: { appendEntry: (customType: string, data?: unknown) => void }, state: AlignmentState) {
	pi.appendEntry(CUSTOM_TYPE, state);
}
