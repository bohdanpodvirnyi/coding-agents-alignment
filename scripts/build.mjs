import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

fs.rmSync(distDir, { recursive: true, force: true });

execFileSync(
	process.execPath,
	[
		path.join(rootDir, "node_modules", "typescript", "bin", "tsc"),
		"--project",
		path.join(rootDir, "tsconfig.build.json"),
	],
	{
		cwd: rootDir,
		stdio: "inherit",
	},
);

const workerSource = path.join(rootDir, "extensions", "alignment", "worker.mjs");
const workerTarget = path.join(distDir, "extensions", "alignment", "worker.mjs");

fs.mkdirSync(path.dirname(workerTarget), { recursive: true });
fs.copyFileSync(workerSource, workerTarget);
