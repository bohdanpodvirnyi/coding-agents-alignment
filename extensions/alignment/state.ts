import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type StatusKey = "todo" | "inProgress" | "finished";
export type AlignmentMode = "idle" | "pending" | "aligned" | "unlinked";

export interface AlignmentState {
	mode: AlignmentMode;
	pendingPrompt?: string;
	itemId?: string;
	itemTitle?: string;
	statusKey?: StatusKey;
	repo?: string;
	branch?: string;
	baseHeadSha?: string;
	prUrl?: string;
	lastSyncAt?: number;
	lastFinishCheckAt?: number;
}

const CUSTOM_TYPE = "pi-agents-alignment-state";

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
