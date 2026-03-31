import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ProjectItemSummary {
	id: string;
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
	prUrl?: string;
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
			if (code !== 0) {
				reject(new Error(stderr.trim() || `Worker exited with code ${code}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as WorkerResponse<T>;
				if (!parsed.ok) reject(new Error(parsed.error));
				else resolve(parsed.result);
			} catch (error) {
				reject(new Error(`Failed to parse worker output: ${String(error)}\n${stdout}`));
			}
		});
		child.stdin.end(JSON.stringify(payload));
	});
}
