#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readToolConfig, writeToolConfig } from "./config.mjs";
import { installCodexHooks, installRepositoryHooks, installWindowsLogonTask } from "./install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const command = args[0] ?? "help";

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function allFlags(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  return values;
}

function run(program, runArgs, options = {}) {
  return new Promise((resolve) => {
    const capture = Boolean(options.capture);
    const child = spawn(program, runArgs, { cwd: options.cwd ?? repoRoot, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function help() {
  console.log(`codex-history-sync

Usage:
  codex-history-sync init --home NAME=PATH [--home NAME=PATH ...] [--data-repo PATH] [--remote URL] [--branch main]
  codex-history-sync install-hooks [--logon-task]
  codex-history-sync sync [--no-pull] [--no-push] [--no-commit]
  codex-history-sync finalize-ui [HOME_NAME]
  codex-history-sync watch-exit HOME_NAME
  codex-history-sync enqueue
  codex-history-sync doctor

Examples:
  codex-history-sync init --home official=~/.codex --home work=D:/AI/.work-codex --data-repo D:/Private/codex-history --remote git@github.com:me/private-history.git
  codex-history-sync install-hooks --logon-task
  codex-history-sync sync
`);
}

async function init() {
  const homes = allFlags("--home").map((definition) => {
    const separator = definition.indexOf("=");
    if (separator < 1) throw new Error(`Invalid --home value: ${definition}; expected NAME=PATH`);
    return { name: definition.slice(0, separator), path: definition.slice(separator + 1), installHooks: true };
  });
  if (homes.length === 0) homes.push({ name: "codex", path: "~/.codex", installHooks: true });
  const branch = flag("--branch") ?? "main";
  const dataRepository = flag("--data-repo") ?? ".";
  const config = {
    schemaVersion: 1,
    homes,
    git: { dataRepository, remote: "origin", branch, autoPull: true, autoPush: true, commitDebounceSeconds: 20 },
    providerSync: { enabled: true, entry: "vendor/codex-provider-sync/src/cli.js", onMissing: "warn" },
    sync: { includeArchived: true, includeSessionIndex: true, propagateDeletes: false, settleMilliseconds: 1500, lockStaleMinutes: 30 }
  };
  await writeToolConfig(repoRoot, config);
  const { config: resolvedConfig } = await readToolConfig(repoRoot);
  await fs.mkdir(resolvedConfig.git.dataRepository, { recursive: true });
  const gitDirectoryExists = await fs.access(path.join(resolvedConfig.git.dataRepository, ".git")).then(() => true).catch(() => false);
  if (!gitDirectoryExists) {
    const initialized = await run("git", ["init", "-b", branch], { cwd: resolvedConfig.git.dataRepository, capture: true });
    if (initialized.code !== 0) throw new Error(initialized.stderr || initialized.stdout || "Unable to initialize data repository.");
  }
  const remoteUrl = flag("--remote");
  if (remoteUrl) {
    const current = await run("git", ["remote", "get-url", "origin"], { cwd: resolvedConfig.git.dataRepository, capture: true });
    const updated = await run("git", ["remote", current.code === 0 ? "set-url" : "add", "origin", remoteUrl], { cwd: resolvedConfig.git.dataRepository, capture: true });
    if (updated.code !== 0) throw new Error(updated.stderr || updated.stdout || "Unable to configure Git remote.");
  }
  await installRepositoryHooks(repoRoot);
  console.log(`Wrote ${path.join(repoRoot, "sync.config.json")}`);
  console.log(`Data repository: ${resolvedConfig.git.dataRepository}`);
}

async function doctor() {
  const { config } = await readToolConfig(repoRoot);
  const rows = [];
  for (const home of config.homes) {
    const sessions = path.join(home.path, "sessions");
    const exists = await fs.access(home.path).then(() => true).catch(() => false);
    const hasSessions = await fs.access(sessions).then(() => true).catch(() => false);
    rows.push({ name: home.name, path: home.path, exists, sessions: hasSessions, hooks: home.installHooks });
  }
  console.table(rows);
  const remote = await run("git", ["remote", "-v"], { cwd: config.git.dataRepository, capture: true });
  process.stdout.write(remote.stdout);
  process.exitCode = remote.code === 0 && rows.every((row) => row.exists) ? 0 : 1;
}

async function main() {
  if (["help", "--help", "-h"].includes(command)) return help();
  if (command === "init") return init();
  if (command === "install-hooks") {
    await installRepositoryHooks(repoRoot);
    const installed = await installCodexHooks(repoRoot);
    if (args.includes("--logon-task")) await installWindowsLogonTask(repoRoot);
    console.table(installed);
    console.log("Open /hooks in each Codex client and trust the new hook definition.");
    return;
  }
  if (command === "doctor") return doctor();
  if (command === "finalize-ui") {
    const result = await run(process.execPath, [path.join(repoRoot, "bin", "finalize-ui-state.mjs"), args[1]].filter(Boolean), { cwd: repoRoot });
    process.exitCode = result.code;
    return;
  }
  if (command === "watch-exit") {
    if (!args[1]) throw new Error("watch-exit requires a home name");
    const watchArgs = [path.join(repoRoot, "bin", "watch-home-exit.mjs"), args[1]];
    const child = spawn(process.execPath, watchArgs, {
      cwd: repoRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref();
    console.log(`Watching ${args[1]} for exit; UI metadata will be finalized afterward.`);
    return;
  }
  if (["sync", "start", "pull", "enqueue", "drain"].includes(command)) {
    const workerArgs = [path.join(repoRoot, "bin", "sync-history.mjs"), command, ...args.slice(1)];
    const result = await run(process.execPath, workerArgs, { cwd: repoRoot });
    process.exitCode = result.code;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
