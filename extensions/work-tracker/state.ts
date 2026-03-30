import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type StatusKey = "todo" | "inProgress" | "finished";

export interface TrackerState {
	mode: "idle" | "tracked" | "skipped";
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

export function emptyTrackerState(): TrackerState {
	return { mode: "idle" };
}

export function loadTrackerState(ctx: ExtensionContext): TrackerState {
	let current = emptyTrackerState();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		current = { ...current, ...(entry.data as Partial<TrackerState>) };
	}
	return current;
}

export function persistTrackerState(pi: { appendEntry: (customType: string, data?: unknown) => void }, state: TrackerState) {
	pi.appendEntry(CUSTOM_TYPE, state);
}
