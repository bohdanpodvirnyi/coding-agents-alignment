import fs from "node:fs";
import path from "node:path";

export interface AlignmentConfig {
	githubOwner: string;
	githubProjectNumber: number;
	repo?: string;
	statusFieldName: string;
	repoFieldName?: string;
	branchFieldName?: string;
	prUrlFieldName?: string;
	agentFieldName?: string;
	visibility: "silent" | "status" | "verbose";
	attachPlanningArtifacts: boolean;
	artifactMaxFiles: number;
	artifactInlineMaxBytes: number;
	statuses: {
		planning: string;
		inProgress: string;
		finished: string;
	};
	finishCheckIntervalMs: number;
}

interface ConfigFileShape {
	githubOwner?: string;
	githubProjectNumber?: number;
	repo?: string;
	statusFieldName?: string;
	repoFieldName?: string;
	branchFieldName?: string;
	prUrlFieldName?: string;
	agentFieldName?: string;
	visibility?: AlignmentConfig["visibility"];
	attachPlanningArtifacts?: boolean;
	artifactMaxFiles?: number;
	artifactInlineMaxBytes?: number;
	statuses?: Partial<AlignmentConfig["statuses"]> & { todo?: string };
	finishCheckIntervalMs?: number;
}

const CONFIG_FILE = ".coding-agents-alignment.json";

const DEFAULT_CONFIG: Omit<AlignmentConfig, "githubOwner" | "githubProjectNumber"> = {
	repo: undefined,
	statusFieldName: "Status",
	repoFieldName: "Repo",
	branchFieldName: "Branch",
	prUrlFieldName: "PR URL",
	agentFieldName: "Agent",
	visibility: "silent",
	attachPlanningArtifacts: true,
	artifactMaxFiles: 20,
	artifactInlineMaxBytes: 32_768,
	statuses: {
		planning: "Planning",
		inProgress: "In Progress",
		finished: "Done",
	},
	finishCheckIntervalMs: 60_000,
};

export function loadAlignmentConfig(startDir: string): { config: AlignmentConfig; path?: string } | null {
	const discovered = findConfigFile(startDir);
	const fileConfig = discovered ? parseConfigFile(discovered) : {};
	const githubOwner = process.env.CODING_AGENTS_ALIGNMENT_GITHUB_OWNER ?? fileConfig.githubOwner;
	const githubProjectNumber = Number(
		process.env.CODING_AGENTS_ALIGNMENT_GITHUB_PROJECT_NUMBER ?? fileConfig.githubProjectNumber,
	);
	if (!githubOwner || !Number.isFinite(githubProjectNumber) || githubProjectNumber <= 0) return null;
	const config: AlignmentConfig = {
		githubOwner,
		githubProjectNumber,
		repo: process.env.CODING_AGENTS_ALIGNMENT_REPO ?? fileConfig.repo ?? DEFAULT_CONFIG.repo,
		statusFieldName:
			process.env.CODING_AGENTS_ALIGNMENT_STATUS_FIELD ?? fileConfig.statusFieldName ?? DEFAULT_CONFIG.statusFieldName,
		repoFieldName:
			process.env.CODING_AGENTS_ALIGNMENT_REPO_FIELD ?? fileConfig.repoFieldName ?? DEFAULT_CONFIG.repoFieldName,
		branchFieldName:
			process.env.CODING_AGENTS_ALIGNMENT_BRANCH_FIELD ?? fileConfig.branchFieldName ?? DEFAULT_CONFIG.branchFieldName,
		prUrlFieldName:
			process.env.CODING_AGENTS_ALIGNMENT_PR_URL_FIELD ?? fileConfig.prUrlFieldName ?? DEFAULT_CONFIG.prUrlFieldName,
		agentFieldName:
			process.env.CODING_AGENTS_ALIGNMENT_AGENT_FIELD ?? fileConfig.agentFieldName ?? DEFAULT_CONFIG.agentFieldName,
		visibility:
			(parseVisibility(process.env.CODING_AGENTS_ALIGNMENT_VISIBILITY) ??
				parseVisibility(fileConfig.visibility) ??
				DEFAULT_CONFIG.visibility),
		attachPlanningArtifacts:
			parseBoolean(process.env.CODING_AGENTS_ALIGNMENT_ATTACH_PLANNING_ARTIFACTS) ??
			fileConfig.attachPlanningArtifacts ??
			DEFAULT_CONFIG.attachPlanningArtifacts,
		artifactMaxFiles:
			parseNumber(process.env.CODING_AGENTS_ALIGNMENT_ARTIFACT_MAX_FILES) ??
			fileConfig.artifactMaxFiles ??
			DEFAULT_CONFIG.artifactMaxFiles,
		artifactInlineMaxBytes:
			parseNumber(process.env.CODING_AGENTS_ALIGNMENT_ARTIFACT_INLINE_MAX_BYTES) ??
			fileConfig.artifactInlineMaxBytes ??
			DEFAULT_CONFIG.artifactInlineMaxBytes,
		statuses: {
			planning:
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_PLANNING ??
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_TODO ??
				fileConfig.statuses?.planning ??
				fileConfig.statuses?.todo ??
				DEFAULT_CONFIG.statuses.planning,
			inProgress:
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_IN_PROGRESS ??
				fileConfig.statuses?.inProgress ??
				DEFAULT_CONFIG.statuses.inProgress,
			finished:
				process.env.CODING_AGENTS_ALIGNMENT_STATUS_FINISHED ??
				fileConfig.statuses?.finished ??
				DEFAULT_CONFIG.statuses.finished,
		},
		finishCheckIntervalMs:
			typeof fileConfig.finishCheckIntervalMs === "number"
				? fileConfig.finishCheckIntervalMs
				: DEFAULT_CONFIG.finishCheckIntervalMs,
	};
	return { config, path: discovered };
}

export function statusLabelToKey(
	config: AlignmentConfig,
	label?: string | null,
): "planning" | "inProgress" | "finished" | undefined {
	if (!label) return undefined;
	if (label === config.statuses.planning) return "planning";
	if (label === config.statuses.inProgress) return "inProgress";
	if (label === config.statuses.finished) return "finished";
	return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseVisibility(value: string | undefined): AlignmentConfig["visibility"] | undefined {
	if (value === "silent" || value === "status" || value === "verbose") return value;
	return undefined;
}

function findConfigFile(startDir: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		const candidate = path.join(current, CONFIG_FILE);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function parseConfigFile(filePath: string): ConfigFileShape {
	const raw = fs.readFileSync(filePath, "utf8");
	return JSON.parse(raw) as ConfigFileShape;
}
