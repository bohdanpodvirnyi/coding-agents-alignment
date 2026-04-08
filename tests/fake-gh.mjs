#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const stateFile = process.env.CODING_AGENTS_ALIGNMENT_TEST_GH_STATE;

if (!stateFile) {
	process.stderr.write("missing CODING_AGENTS_ALIGNMENT_TEST_GH_STATE\n");
	process.exit(1);
}

const args = process.argv.slice(2);

try {
	if (args[0] === "api" && args[1] === "graphql") {
		handleGraphql(args.slice(2));
		process.exit(0);
	}

	if (args[0] === "api") {
		handleApi(args.slice(1));
		process.exit(0);
	}

	if (args[0] === "repo" && args[1] === "view") {
		handleRepoView();
		process.exit(0);
	}

	if (args[0] === "pr" && args[1] === "list") {
		handlePrList(args.slice(2));
		process.exit(0);
	}

	process.stderr.write(`unsupported gh invocation: ${args.join(" ")}\n`);
	process.exit(1);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

function handleApi(apiArgs) {
	const state = readState();
	const endpoint = apiArgs[0];
	if (endpoint === "user") {
		process.stdout.write(`${state.currentUser}\n`);
		return;
	}

	const method = readOption(apiArgs, "--method") ?? "GET";
	const body = apiArgs.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8") || "{}") : undefined;

	if (endpoint.startsWith("/repos/") && endpoint.endsWith("/issues") && method === "POST") {
		if (state.fail.issueCreate) throw new Error("issue creation failed");
		const repoFullName = endpoint.replace(/^\/repos\//, "").replace(/\/issues$/, "");
		const issue = createIssue(state, repoFullName, body ?? {});
		writeState(state);
		process.stdout.write(JSON.stringify(issue));
		return;
	}

	if (/^\/repos\/.+\/issues\/\d+\/comments$/.test(endpoint) && method === "POST") {
		if (state.fail.commentIssue) throw new Error("issue comment failed");
		const match = endpoint.match(/^\/repos\/(.+)\/issues\/(\d+)\/comments$/);
		if (!match) throw new Error(`bad comments endpoint: ${endpoint}`);
		const repoFullName = match[1];
		const issueNumber = Number(match[2]);
		const repo = ensureRepo(state, repoFullName);
		const issue = repo.issues.find((candidate) => candidate.number === issueNumber);
		if (!issue) throw new Error(`issue not found: ${repoFullName}#${issueNumber}`);
		const comment = {
			id: issue.comments.length + 1,
			body: String(body?.body ?? ""),
		};
		issue.comments.push(comment);
		writeState(state);
		process.stdout.write(JSON.stringify(comment));
		return;
	}

	throw new Error(`unsupported gh api endpoint: ${endpoint}`);
}

function handleRepoView() {
	const state = readState();
	process.stdout.write(`${state.defaultBranch}\n`);
}

function handlePrList(prArgs) {
	const state = readState();
	const head = readOption(prArgs, "--head");
	const match = state.openPullRequests.find((pr) => pr.head === head);
	process.stdout.write(match ? `${match.url}\n` : "\n");
}

function handleGraphql(graphqlArgs) {
	const state = readState();
	const { query, variables } = parseGraphqlArgs(graphqlArgs);

	if (state.fail.projectFetch && query.includes("projectV2(number: $number)")) {
		throw new Error("project fetch failed");
	}

	if (query.includes("projectV2(number: $number)")) {
		const rootKey = query.includes("organization(login: $owner)") ? "organization" : "user";
		process.stdout.write(JSON.stringify({
			data: {
				[rootKey]: {
					projectV2: serializeProject(state.project),
				},
			},
		}));
		return;
	}

	if (query.includes("addProjectV2ItemById")) {
		const issue = findIssueByNodeId(state, String(variables.contentId));
		if (!issue) throw new Error(`issue content not found: ${variables.contentId}`);
		const item = createIssueBackedItem(state, issue);
		writeState(state);
		process.stdout.write(JSON.stringify({
			data: {
				addProjectV2ItemById: {
					item: { id: item.id },
				},
			},
		}));
		return;
	}

	if (query.includes("addProjectV2DraftIssue")) {
		const item = createDraftItem(state, String(variables.title), String(variables.body));
		writeState(state);
		process.stdout.write(JSON.stringify({
			data: {
				addProjectV2DraftIssue: {
					projectItem: { id: item.id },
				},
			},
		}));
		return;
	}

	if (query.includes("updateProjectV2ItemFieldValue")) {
		const item = state.project.items.find((candidate) => candidate.id === String(variables.itemId));
		if (!item) throw new Error(`project item not found: ${variables.itemId}`);
		const field = state.project.fields.find((candidate) => candidate.id === String(variables.fieldId));
		if (!field) throw new Error(`field not found: ${variables.fieldId}`);
		if (typeof variables.text === "string") {
			item.fieldValues[field.name] = variables.text;
		} else if (typeof variables.optionId === "string") {
			const option = field.options?.find((candidate) => candidate.id === variables.optionId);
			if (!option) throw new Error(`option not found: ${variables.optionId}`);
			item.fieldValues[field.name] = option.name;
		}
		writeState(state);
		process.stdout.write(JSON.stringify({
			data: {
				updateProjectV2ItemFieldValue: {
					projectV2Item: { id: item.id },
				},
			},
		}));
		return;
	}

	throw new Error("unsupported graphql operation");
}

function parseGraphqlArgs(graphqlArgs) {
	let query = "";
	const variables = {};

	for (let i = 0; i < graphqlArgs.length; i += 1) {
		const token = graphqlArgs[i];
		if (token !== "-f" && token !== "-F") continue;
		const assignment = graphqlArgs[i + 1] ?? "";
		i += 1;
		const separator = assignment.indexOf("=");
		const key = separator >= 0 ? assignment.slice(0, separator) : assignment;
		const rawValue = separator >= 0 ? assignment.slice(separator + 1) : "";
		if (key === "query") {
			query = rawValue;
			continue;
		}
		variables[key] = token === "-F" && /^-?\d+$/.test(rawValue) ? Number(rawValue) : rawValue;
	}

	return { query, variables };
}

function readOption(argv, name) {
	const index = argv.indexOf(name);
	if (index === -1) return undefined;
	return argv[index + 1];
}

function createIssue(state, repoFullName, payload) {
	const repo = ensureRepo(state, repoFullName);
	const issueNumber = state.nextIssueNumber;
	state.nextIssueNumber += 1;
	const issue = {
		number: issueNumber,
		node_id: `ISSUE_${issueNumber}`,
		html_url: `https://github.com/${repoFullName}/issues/${issueNumber}`,
		title: String(payload.title ?? ""),
		body: String(payload.body ?? ""),
		assignees: Array.isArray(payload.assignees) ? payload.assignees.map(String) : [],
		comments: [],
	};
	repo.issues.push(issue);
	return issue;
}

function createIssueBackedItem(state, issue) {
	const existing = state.project.items.find((item) => item.contentId === issue.node_id);
	if (existing) return existing;
	const item = {
		id: `ITEM_${state.nextItemNumber++}`,
		contentType: "Issue",
		contentId: issue.node_id,
		contentUrl: issue.html_url,
		title: issue.title,
		body: issue.body,
		fieldValues: {},
	};
	state.project.items.push(item);
	return item;
}

function createDraftItem(state, title, body) {
	const item = {
		id: `ITEM_${state.nextItemNumber++}`,
		contentType: "DraftIssue",
		contentId: `DRAFT_${state.nextDraftNumber++}`,
		contentUrl: undefined,
		title,
		body,
		fieldValues: {},
	};
	state.project.items.push(item);
	return item;
}

function serializeProject(project) {
	return {
		id: project.id,
		fields: {
			nodes: project.fields.map((field) => field.type === "single_select"
				? {
					id: field.id,
					name: field.name,
					dataType: "SINGLE_SELECT",
					options: field.options,
				}
				: {
					id: field.id,
					name: field.name,
					dataType: "TEXT",
				}),
		},
		items: {
			nodes: project.items.map((item) => ({
				id: item.id,
				content: item.contentType === "Issue"
					? {
						id: item.contentId,
						title: item.title,
						url: item.contentUrl,
					}
					: {
						id: item.contentId,
						title: item.title,
					},
				fieldValues: {
					nodes: Object.entries(item.fieldValues).map(([fieldName, value]) => {
						const field = project.fields.find((candidate) => candidate.name === fieldName);
						if (field?.type === "single_select") {
							return {
								name: value,
								field: { name: fieldName },
							};
						}
						return {
							text: value,
							field: { name: fieldName },
						};
					}),
				},
			})),
		},
	};
}

function ensureRepo(state, repoFullName) {
	state.repos[repoFullName] ??= { issues: [] };
	return state.repos[repoFullName];
}

function findIssueByNodeId(state, nodeId) {
	for (const repo of Object.values(state.repos)) {
		const issue = repo.issues.find((candidate) => candidate.node_id === nodeId);
		if (issue) return issue;
	}
	return undefined;
}

function readState() {
	return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function writeState(state) {
	fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
