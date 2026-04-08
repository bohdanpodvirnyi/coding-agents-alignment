import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ProjectItemSummary {
	id: string;
	contentId?: string;
	contentUrl?: string;
	title: string;
	status?: string;
	repo?: string;
	branch?: string;
	prUrl?: string;
}

export interface ProjectSnapshot {
	projectId: string;
	items: ProjectItemSummary[];
}

export interface GitState {
	repo: string;
	repoFullName?: string;
	branch: string;
	defaultBranch?: string;
	headSha?: string;
	headMergedToDefault?: boolean;
	prUrl?: string;
}

export interface PlanningArtifact {
	path: string;
	status: string;
	content?: string;
	contentTruncated?: boolean;
}

export interface PlanningArtifactsSnapshot {
	root: string;
	files: PlanningArtifact[];
}

type WorkerRequest = Record<string, unknown>;

type WorkerResponse<T> =
	| { ok: true; result: T }
	| { ok: false; error: string };

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));

export async function runWorker<T>(cwd: string, payload: WorkerRequest): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const child = spawn(process.execPath, [WORKER_PATH], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			try {
				if (stdout.trim()) {
					const parsed = JSON.parse(stdout) as WorkerResponse<T>;
					if (!parsed.ok) {
						reject(new Error(parsed.error));
						return;
					}
					resolve(parsed.result);
					return;
				}
				if (code !== 0) {
					reject(new Error(stderr.trim() || `Worker exited with code ${code}`));
					return;
				}
				reject(new Error("Worker returned no output"));
			} catch (error) {
				reject(new Error(`Failed to parse worker output: ${String(error)}\n${stdout || stderr}`));
			}
		});
		child.stdin.end(JSON.stringify(payload));
	});
}
