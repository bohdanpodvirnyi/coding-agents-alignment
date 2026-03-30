import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CONFIG_FILE = ".pi-agents-alignment.json";

const DEFAULTS = {
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
};

main();

async function main() {
	try {
		const raw = await readStdin();
		const payload = JSON.parse(raw || "{}");
		const result = await handle(payload);
		process.stdout.write(JSON.stringify({ ok: true, result }));
	} catch (error) {
		process.stdout.write(JSON.stringify({ ok: false, error: formatError(error) }));
		process.exitCode = 1;
	}
}

async function handle(payload) {
	switch (payload.command) {
		case "projectSnapshot":
			return getProjectSnapshot(process.cwd());
		case "createItem":
			return createItem(process.cwd(), payload);
		case "updateItem":
			return updateItem(process.cwd(), payload);
		case "gitState":
			return getGitState(process.cwd());
		default:
			throw new Error(`Unknown worker command: ${String(payload.command)}`);
	}
}

function loadConfig(cwd) {
	const filePath = findConfigFile(cwd);
	const fileConfig = filePath ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
	const githubOwner = process.env.PI_ALIGNMENT_GITHUB_OWNER ?? fileConfig.githubOwner;
	const githubProjectNumber = Number(process.env.PI_ALIGNMENT_GITHUB_PROJECT_NUMBER ?? fileConfig.githubProjectNumber);
	if (!githubOwner || !Number.isFinite(githubProjectNumber) || githubProjectNumber <= 0) {
		throw new Error(`Missing GitHub Project config. Set ${CONFIG_FILE} or PI_ALIGNMENT_GITHUB_* env vars.`);
	}
	return {
		githubOwner,
		githubProjectNumber,
		repo: process.env.PI_ALIGNMENT_REPO ?? fileConfig.repo,
		statusFieldName: process.env.PI_ALIGNMENT_STATUS_FIELD ?? fileConfig.statusFieldName ?? DEFAULTS.statusFieldName,
		repoFieldName: process.env.PI_ALIGNMENT_REPO_FIELD ?? fileConfig.repoFieldName ?? DEFAULTS.repoFieldName,
		branchFieldName: process.env.PI_ALIGNMENT_BRANCH_FIELD ?? fileConfig.branchFieldName ?? DEFAULTS.branchFieldName,
		prUrlFieldName: process.env.PI_ALIGNMENT_PR_URL_FIELD ?? fileConfig.prUrlFieldName ?? DEFAULTS.prUrlFieldName,
		agentFieldName: process.env.PI_ALIGNMENT_AGENT_FIELD ?? fileConfig.agentFieldName ?? DEFAULTS.agentFieldName,
		statuses: {
			todo: process.env.PI_ALIGNMENT_STATUS_TODO ?? fileConfig.statuses?.todo ?? DEFAULTS.statuses.todo,
			inProgress:
				process.env.PI_ALIGNMENT_STATUS_IN_PROGRESS ?? fileConfig.statuses?.inProgress ?? DEFAULTS.statuses.inProgress,
			finished: process.env.PI_ALIGNMENT_STATUS_FINISHED ?? fileConfig.statuses?.finished ?? DEFAULTS.statuses.finished,
		},
	};
}

function getProjectSnapshot(cwd) {
	const config = loadConfig(cwd);
	const data = ghGraphql(cwd, PROJECT_QUERY, {
		owner: config.githubOwner,
		number: config.githubProjectNumber,
	});
	const project = extractProject(data);
	if (!project) {
		throw new Error(`Project ${config.githubOwner}#${config.githubProjectNumber} not found.`);
	}
	return {
		projectId: project.id,
		items: (project.items?.nodes ?? [])
			.map((node) => mapProjectItem(node, config))
			.filter((item) => Boolean(item.title)),
	};
}

function createItem(cwd, payload) {
	const config = loadConfig(cwd);
	const snapshot = getProjectData(cwd, config);
	const title = String(payload.title ?? "").trim();
	if (!title) throw new Error("createItem requires title");
	const body = String(payload.body ?? "").trim();
	const created = ghGraphql(cwd, CREATE_DRAFT_MUTATION, {
		projectId: snapshot.project.id,
		title,
		body,
	});
	const itemId = created.addProjectV2DraftIssue?.projectItem?.id;
	if (!itemId) throw new Error("GitHub did not return created project item id.");
	applyFieldUpdates(cwd, snapshot, itemId, payload);
	return { itemId, title };
}

function updateItem(cwd, payload) {
	const snapshot = getProjectData(cwd, loadConfig(cwd));
	const itemId = String(payload.itemId ?? "").trim();
	if (!itemId) throw new Error("updateItem requires itemId");
	applyFieldUpdates(cwd, snapshot, itemId, payload);
	return { itemId };
}

function applyFieldUpdates(cwd, snapshot, itemId, payload) {
	const { project, fieldMap, statusOptions, config } = snapshot;
	if (payload.statusKey) {
		const label = config.statuses[payload.statusKey];
		const optionId = statusOptions.get(label);
		if (!optionId) throw new Error(`Status option not found: ${label}`);
		updateSingleSelectField(cwd, project.id, itemId, fieldMap.get(config.statusFieldName)?.id, optionId);
	}
	updateOptionalTextField(cwd, project.id, itemId, fieldMap.get(config.repoFieldName)?.id, payload.repo);
	updateOptionalTextField(cwd, project.id, itemId, fieldMap.get(config.branchFieldName)?.id, payload.branch);
	updateOptionalTextField(cwd, project.id, itemId, fieldMap.get(config.prUrlFieldName)?.id, payload.prUrl);
	updateOptionalTextField(cwd, project.id, itemId, fieldMap.get(config.agentFieldName)?.id, payload.agent);
}

function getProjectData(cwd, config) {
	const data = ghGraphql(cwd, PROJECT_QUERY, {
		owner: config.githubOwner,
		number: config.githubProjectNumber,
	});
	const project = extractProject(data);
	if (!project) throw new Error(`Project ${config.githubOwner}#${config.githubProjectNumber} not found.`);
	const fieldMap = new Map();
	const statusOptions = new Map();
	for (const field of project.fields?.nodes ?? []) {
		if (!field?.name) continue;
		fieldMap.set(field.name, field);
		if (field.name === config.statusFieldName) {
			for (const option of field.options ?? []) {
				statusOptions.set(option.name, option.id);
			}
		}
	}
	if (!fieldMap.has(config.statusFieldName)) {
		throw new Error(`Project field missing: ${config.statusFieldName}`);
	}
	return { project, fieldMap, statusOptions, config };
}

function mapProjectItem(node, config) {
	const content = node.content ?? {};
	const values = fieldValuesToMap(node.fieldValues?.nodes ?? []);
	return {
		id: node.id,
		title: content.title ?? "",
		status: values.get(config.statusFieldName),
		repo: values.get(config.repoFieldName),
		branch: values.get(config.branchFieldName),
		prUrl: values.get(config.prUrlFieldName),
	};
}

function fieldValuesToMap(nodes) {
	const values = new Map();
	for (const node of nodes) {
		const fieldName = node.field?.name;
		if (!fieldName) continue;
		if (typeof node.text === "string") values.set(fieldName, node.text);
		if (typeof node.name === "string") values.set(fieldName, node.name);
	}
	return values;
}

function updateOptionalTextField(cwd, projectId, itemId, fieldId, value) {
	if (!fieldId || value === undefined || value === null || value === "") return;
	ghGraphql(cwd, UPDATE_TEXT_FIELD_MUTATION, {
		projectId,
		itemId,
		fieldId,
		text: String(value),
	});
}

function updateSingleSelectField(cwd, projectId, itemId, fieldId, optionId) {
	if (!fieldId) throw new Error("Missing single-select field id");
	ghGraphql(cwd, UPDATE_SELECT_FIELD_MUTATION, {
		projectId,
		itemId,
		fieldId,
		optionId,
	});
}

function getGitState(cwd) {
	const config = loadConfig(cwd);
	const root = tryRun(cwd, "git", ["rev-parse", "--show-toplevel"]);
	if (!root) throw new Error("Not inside a git repository.");
	const branch = tryRun(cwd, "git", ["branch", "--show-current"]) ?? "";
	const headSha = tryRun(cwd, "git", ["rev-parse", "HEAD"]);
	const defaultBranch =
		parseRemoteHead(tryRun(cwd, "git", ["symbolic-ref", "refs/remotes/origin/HEAD"])) ??
		tryRun(cwd, "gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
	const repo = config.repo ?? inferRepoName(cwd, root);
	const prUrl = branch
		? tryRun(cwd, "gh", [
				"pr",
				"list",
				"--state",
				"open",
				"--head",
				branch,
				"--json",
				"url",
				"--jq",
				".[0].url",
		  ])
		: undefined;
	return { repo, branch, defaultBranch: defaultBranch ?? undefined, headSha: headSha ?? undefined, prUrl: prUrl ?? undefined };
}

function inferRepoName(cwd, root) {
	const remote = tryRun(cwd, "git", ["remote", "get-url", "origin"]);
	const parsed = remote ? remote.match(/[:/]([^/]+\/[^/.]+)(?:\.git)?$/) : null;
	if (parsed) return parsed[1].split("/")[1];
	return path.basename(root);
}

function parseRemoteHead(value) {
	if (!value) return undefined;
	const parts = value.trim().split("/");
	return parts[parts.length - 1];
}

function ghGraphql(cwd, query, variables) {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [key, value] of Object.entries(variables)) {
		args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
	}
	const raw = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const parsed = JSON.parse(raw);
	return parsed.data ?? parsed;
}

function extractProject(data) {
	return data.user?.projectV2;
}

function tryRun(cwd, command, args) {
	try {
		return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function findConfigFile(startDir) {
	let current = path.resolve(startDir);
	while (true) {
		const candidate = path.join(current, CONFIG_FILE);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

function formatError(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

const PROJECT_QUERY = `
query($owner: String!, $number: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
        }
      }
      items(first: 100) {
        nodes {
          id
          content {
            ... on DraftIssue {
              title
            }
            ... on Issue {
              title
            }
          }
          fieldValues(first: 50) {
            nodes {
              ... on ProjectV2ItemFieldTextValue {
                text
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`.trim();

const CREATE_DRAFT_MUTATION = `
mutation($projectId: ID!, $title: String!, $body: String!) {
  addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
    projectItem {
      id
    }
  }
}`.trim();

const UPDATE_TEXT_FIELD_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { text: $text }
    }
  ) {
    projectV2Item {
      id
    }
  }
}`.trim();

const UPDATE_SELECT_FIELD_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) {
    projectV2Item {
      id
    }
  }
}`.trim();
