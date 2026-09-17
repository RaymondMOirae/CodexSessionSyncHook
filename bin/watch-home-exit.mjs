#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readToolConfig } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const homeSelector = process.argv[2];
if (!homeSelector) throw new Error("Usage: watch-home-exit.mjs HOME_NAME_OR_PATH");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(program, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd: options.cwd ?? repoRoot, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function clientProcesses(home) {
  if (process.platform !== "win32") return [];
  const configured = home.uiStateExitProcessPaths ?? [];
  if (configured.length === 0) return [];
  const roots = configured.map((value) => path.resolve(value).replaceAll("'", "''").toLowerCase());
  const rootsLiteral = roots.map((value) => `'${value}'`).join(",");
  const script = `$roots=@(${rootsLiteral}); Get-CimInstance Win32_Process | Where-Object { $p=$_.ExecutablePath; $p -and ($roots | Where-Object { $p.ToLowerInvariant().StartsWith($_) } | Select-Object -First 1) } | Select-Object -ExpandProperty ProcessId`;
  const result = await run("powershell.exe", ["-NoProfile", "-Command", script]);
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter(Number.isInteger);
}

async function log(message) {
  const { config } = await readToolConfig(repoRoot);
  const logPath = path.join(config.git.dataRepository, ".sync", "watch-home-exit.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

async function waitForStableState(homePath, stableMilliseconds = 5000) {
  const statePath = path.join(homePath, ".codex-global-state.json");
  let previous = null;
  let stableSince = Date.now();
  for (;;) {
    let signature = "missing";
    try {
      const stat = await fs.stat(statePath);
      signature = `${stat.size}:${stat.mtimeMs}`;
    } catch {}
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= stableMilliseconds) return;
    await sleep(500);
  }
}

async function main() {
  const { config } = await readToolConfig(repoRoot);
  const selectorPath = path.resolve(homeSelector).toLowerCase();
  const home = config.homes.find((entry) => entry.name === homeSelector || path.resolve(entry.path).toLowerCase() === selectorPath);
  if (!home) throw new Error(`Unknown Codex home: ${homeSelector}`);
  if (home.finalizeUiOnExit !== true) return;
  const lockPath = path.join(config.git.dataRepository, ".sync", `watch-${home.name.replace(/[^a-z0-9_.-]/gi, "_")}.lock`);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(String(process.pid), "utf8");
    await handle.close();
  } catch (error) {
    if (error?.code === "EEXIST") return;
    throw error;
  }

  try {
    let observedRunning = false;
    for (;;) {
      const running = (await clientProcesses(home)).filter((pid) => pid !== process.pid);
      if (running.length > 0) observedRunning = true;
      if (observedRunning && running.length === 0) break;
      await sleep(2000);
    }

    await waitForStableState(home.path);
    const result = await run(process.execPath, [path.join(__dirname, "finalize-ui-state.mjs"), home.name], { cwd: repoRoot });
    await log(`finalize ${home.name}: code=${result.code} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`);
    process.exitCode = result.code;
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

main().catch(async (error) => {
  await log(`fatal ${homeSelector}: ${error.stack || error.message}`).catch(() => {});
  process.exitCode = 1;
});
