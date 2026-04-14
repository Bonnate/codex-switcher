#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const viteBin = path.join(repoRoot, "node_modules", ".bin", isWindows ? "vite.CMD" : "vite");

const child = spawn(viteBin, [], {
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
  console.error(`Failed to start Vite: ${error.message}`);
  process.exit(1);
});