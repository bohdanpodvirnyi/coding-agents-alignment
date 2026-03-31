import type { ProjectItemSummary } from "./worker-client.js";

const LEADING_PHRASES = [
	/^please\s+/i,
	/^can you\s+/i,
	/^i have this idea[:\s-]*/i,
	/^let'?s\s+/i,
	/^we need to\s+/i,
	/^help me\s+/i,
];

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
