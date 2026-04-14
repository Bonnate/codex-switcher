#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

const tscBin = path.join(repoRoot, "node_modules", ".bin", isWindows ? "tsc.CMD" : "tsc");
const viteBin = path.join(repoRoot, "node_modules", ".bin", isWindows ? "vite.CMD" : "vite");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: isWindows,
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} exited with code ${code ?? 1}`));
      }
    });

    child.on("error", (error) => reject(error));
  });
}

try {
  await run(tscBin, []);
  await run(viteBin, ["build"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}