import type { ProjectItemSummary } from "./worker-client.js";

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

export function generateSummary(prompt: string): string {
	const singleLine = prompt.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
	const firstSentence = singleLine.split(/[.!?]\s/)[0] ?? singleLine;
	let summary = firstSentence;
	for (const phrase of LEADING_PHRASES) summary = summary.replace(phrase, "");
	summary = summary.replace(/^to\s+/i, "").trim();
	if (!summary) summary = "Untitled work";
	if (summary.length > 72) summary = `${summary.slice(0, 69).trimEnd()}...`;
	return capitalize(summary);
}

export function appendRecentPrompt(prompts: string[] | undefined, prompt: string): string[] {
	const cleaned = normalizePrompt(prompt);
	if (!cleaned) return prompts ?? [];
	const next = [...(prompts ?? [])];
	if (next[next.length - 1] !== cleaned) next.push(cleaned);
	return next.slice(-MAX_RECENT_PROMPTS);
}

export function inferPromptFromHistory(prompts: string[] | undefined): string | undefined {
	const cleaned = (prompts ?? []).map(normalizePrompt).filter(Boolean);
	if (cleaned.length === 0) return undefined;

	for (let i = cleaned.length - 1; i >= 0; i -= 1) {
		const prompt = cleaned[i]!;
		if (SLASH_COMMAND_RE.test(prompt)) continue;
		if (!isLightweightFollowUp(prompt)) return prompt;
	}

	return cleaned.find((prompt) => !SLASH_COMMAND_RE.test(prompt));
}

export function isSubstantivePrompt(prompt: string): boolean {
	const cleaned = normalizePrompt(prompt);
	if (!cleaned || SLASH_COMMAND_RE.test(cleaned)) return false;
	if (isLightweightFollowUp(cleaned)) return false;
	return cleaned.length >= 12;
}

export function isLikelyTaskSwitch(prompt: string, currentTitle?: string): boolean {
	const cleaned = normalizePrompt(prompt);
	if (!isSubstantivePrompt(cleaned) || !currentTitle) return false;
	if (TASK_SWITCH_RE.test(cleaned)) return true;
	const score = similarityScore(generateSummary(cleaned), currentTitle);
	return score < 0.12;
}

export function formatPlanningNotes(prompts: string[] | undefined): string[] {
	const notes = (prompts ?? [])
		.map(normalizePrompt)
		.filter(Boolean)
		.filter((prompt) => !SLASH_COMMAND_RE.test(prompt));
	return [...new Set(notes)];
}

export function rankSimilarItems(summary: string, items: ProjectItemSummary[]): Array<ProjectItemSummary & { score: number }> {
	return items
		.map((item) => ({ ...item, score: similarityScore(summary, item.title) }))
		.filter((item) => item.score >= 0.2)
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);
}

function similarityScore(left: string, right: string): number {
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

function normalizePrompt(prompt: string): string {
	return prompt.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

function isLightweightFollowUp(prompt: string): boolean {
	return prompt.length <= 24 || LIGHTWEIGHT_FOLLOW_UP_RE.test(prompt);
}

function tokenize(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter((token) => token.length >= 3),
	);
}

function capitalize(value: string): string {
	return value ? value[0].toUpperCase() + value.slice(1) : value;
}
