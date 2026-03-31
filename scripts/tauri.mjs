#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tauriBin =
  process.platform === "win32"
    ? path.join(repoRoot, "node_modules", ".bin", "tauri.cmd")
    : path.join(repoRoot, "node_modules", ".bin", "tauri");

const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const cargoBinDir = path.join(os.homedir(), ".cargo", "bin");
const cargoBin =
  process.platform === "win32"
    ? path.join(cargoBinDir, "cargo.exe")
    : path.join(cargoBinDir, "cargo");

if (existsSync(cargoBin)) {
  env[pathKey] = [cargoBinDir, env[pathKey] ?? ""].filter(Boolean).join(path.delimiter);
}

if (!existsSync(tauriBin)) {
  console.error("Error: Tauri CLI not found. Run `pnpm install` first.");
  process.exit(1);
}

const cargoCheck = spawnSync("cargo", ["--version"], {
  env,
  shell: process.platform === "win32",
  stdio: "ignore",
});

if (cargoCheck.status !== 0) {
  console.error("Error: cargo not found. Install Rust via rustup: https://rustup.rs");
  process.exit(1);
}

const child = spawn(tauriBin, process.argv.slice(2), {
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
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
