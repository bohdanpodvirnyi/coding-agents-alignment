import fs from "node:fs";
import path from "node:path";

export interface TrackerConfig {
	githubOwner: string;
	githubProjectNumber: number;
	repo?: string;
	statusFieldName: string;
	repoFieldName?: string;
	branchFieldName?: string;
	prUrlFieldName?: string;
	agentFieldName?: string;
	statuses: {
		todo: string;
		inProgress: string;
		finished: string;
	};
	askKeywords: string[];
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
	statuses?: Partial<TrackerConfig["statuses"]>;
	askKeywords?: string[];
	finishCheckIntervalMs?: number;
}

const CONFIG_FILE = ".pi-agents-alignment.json";

const DEFAULT_CONFIG: Omit<TrackerConfig, "githubOwner" | "githubProjectNumber"> = {
	repo: undefined,
	statusFieldName: "Status",
	repoFieldName: "Repo",
	branchFieldName: "Branch",
	prUrlFieldName: "PR URL",
	agentFieldName: "Agent",
	statuses: {
		todo: "Todo",
		inProgress: "In Progress",
		finished: "Finished",
	},
	askKeywords: ["implement", "build", "add", "create", "fix", "refactor", "feature"],
	finishCheckIntervalMs: 60_000,
};

export function loadTrackerConfig(startDir: string): { config: TrackerConfig; path?: string } | null {
	const discovered = findConfigFile(startDir);
	const fileConfig = discovered ? parseConfigFile(discovered) : {};
	const githubOwner = process.env.PI_ALIGNMENT_GITHUB_OWNER ?? fileConfig.githubOwner;
	const githubProjectNumber = Number(process.env.PI_ALIGNMENT_GITHUB_PROJECT_NUMBER ?? fileConfig.githubProjectNumber);
	if (!githubOwner || !Number.isFinite(githubProjectNumber) || githubProjectNumber <= 0) return null;
	const config: TrackerConfig = {
		githubOwner,
		githubProjectNumber,
		repo: process.env.PI_ALIGNMENT_REPO ?? fileConfig.repo ?? DEFAULT_CONFIG.repo,
		statusFieldName: process.env.PI_ALIGNMENT_STATUS_FIELD ?? fileConfig.statusFieldName ?? DEFAULT_CONFIG.statusFieldName,
		repoFieldName: process.env.PI_ALIGNMENT_REPO_FIELD ?? fileConfig.repoFieldName ?? DEFAULT_CONFIG.repoFieldName,
		branchFieldName:
			process.env.PI_ALIGNMENT_BRANCH_FIELD ?? fileConfig.branchFieldName ?? DEFAULT_CONFIG.branchFieldName,
		prUrlFieldName: process.env.PI_ALIGNMENT_PR_URL_FIELD ?? fileConfig.prUrlFieldName ?? DEFAULT_CONFIG.prUrlFieldName,
		agentFieldName: process.env.PI_ALIGNMENT_AGENT_FIELD ?? fileConfig.agentFieldName ?? DEFAULT_CONFIG.agentFieldName,
		statuses: {
			todo: process.env.PI_ALIGNMENT_STATUS_TODO ?? fileConfig.statuses?.todo ?? DEFAULT_CONFIG.statuses.todo,
			inProgress:
				process.env.PI_ALIGNMENT_STATUS_IN_PROGRESS ??
				fileConfig.statuses?.inProgress ??
				DEFAULT_CONFIG.statuses.inProgress,
			finished:
				process.env.PI_ALIGNMENT_STATUS_FINISHED ??
				fileConfig.statuses?.finished ??
				DEFAULT_CONFIG.statuses.finished,
		},
		askKeywords: fileConfig.askKeywords?.length ? fileConfig.askKeywords : DEFAULT_CONFIG.askKeywords,
		finishCheckIntervalMs:
			typeof fileConfig.finishCheckIntervalMs === "number"
				? fileConfig.finishCheckIntervalMs
				: DEFAULT_CONFIG.finishCheckIntervalMs,
	};
	return { config, path: discovered };
}

export function statusLabelToKey(config: TrackerConfig, label?: string | null): "todo" | "inProgress" | "finished" | undefined {
	if (!label) return undefined;
	if (label === config.statuses.todo) return "todo";
	if (label === config.statuses.inProgress) return "inProgress";
	if (label === config.statuses.finished) return "finished";
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
	const parsed = JSON.parse(raw) as ConfigFileShape;
	return parsed;
}
