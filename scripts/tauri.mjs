#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

const tauriBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  isWindows ? "tauri.CMD" : "tauri"
);

if (!existsSync(tauriBin)) {
  console.error("Tauri CLI not found. Run `pnpm install` first.");
  process.exit(1);
}

const child = spawn(tauriBin, process.argv.slice(2), {
  cwd: repoRoot,
  stdio: "inherit",
  shell: isWindows,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start Tauri CLI: ${error.message}`);
  process.exit(1);
});
