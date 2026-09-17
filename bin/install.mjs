import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readToolConfig } from "./config.mjs";

function run(program, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function ensureFeaturesHooks(configPath) {
  let text = await fs.readFile(configPath, "utf8").catch(() => "");
  // TOML requires CR to be followed by LF. Normalize existing mixed/bare
  // newlines before editing so repeated installs cannot corrupt the file.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/^\s*\[features\]\s*$/m.test(text)) {
    if (/^\s*hooks\s*=/m.test(text)) text = text.replace(/^\s*hooks\s*=.*$/m, "hooks = true");
    else text = text.replace(/^\s*\[features\]\s*$/m, "[features]\nhooks = true");
  } else {
    text = `${text.trimEnd()}\n\n[features]\nhooks = true\n`;
  }
  await fs.writeFile(configPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

export async function installCodexHooks(repoRoot) {
  const { config } = await readToolConfig(repoRoot);
  const hookEntry = path.join(repoRoot, "bin", "hook-entry.mjs");
  const nodePath = process.execPath;
  const command = `"${nodePath}" "${hookEntry}"`;
  const hookConfig = {
    description: "Git-backed Codex conversation history synchronization",
    hooks: {
      SessionStart: [{
        matcher: "startup|resume",
        hooks: [{
          type: "command",
          command: `${command} start`,
          commandWindows: `${command} start`,
          timeout: 180,
          statusMessage: "Synchronizing Codex conversation history"
        }]
      }],
      SessionEnd: [{
        hooks: [{
          type: "command",
          command: `${command} enqueue`,
          commandWindows: `${command} enqueue`,
          timeout: 3
        }]
      }]
    }
  };

  const installed = [];
  for (const home of config.homes.filter((entry) => entry.installHooks)) {
    await fs.mkdir(home.path, { recursive: true });
    const hooksPath = path.join(home.path, "hooks.json");
    if (await exists(hooksPath)) await fs.copyFile(hooksPath, `${hooksPath}.bak.${Date.now()}`);
    await fs.writeFile(hooksPath, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf8");
    const configPath = path.join(home.path, "config.toml");
    if (await exists(configPath)) await fs.copyFile(configPath, `${configPath}.bak.history-sync.${Date.now()}`);
    await ensureFeaturesHooks(configPath);
    installed.push({ name: home.name, path: home.path });
  }
  return installed;
}

export async function installRepositoryHooks(repoRoot) {
  const { config } = await readToolConfig(repoRoot);
  const dataRepoRoot = config.git.dataRepository;
  const lfs = await run("git", ["lfs", "install", "--local", "--force"], { cwd: dataRepoRoot });
  if (lfs.code !== 0) throw new Error(`git lfs install failed: ${lfs.stderr || lfs.stdout}`);
  if (dataRepoRoot === repoRoot) {
    const hooks = await run("git", ["config", "core.hooksPath", ".githooks"], { cwd: dataRepoRoot });
    if (hooks.code !== 0) throw new Error(`git hooks configuration failed: ${hooks.stderr || hooks.stdout}`);
  } else {
    const hooksRoot = path.join(dataRepoRoot, ".githooks");
    await fs.mkdir(hooksRoot, { recursive: true });
    const nodePath = process.execPath.replace(/\\/g, "/");
    const workerPath = path.join(repoRoot, "bin", "sync-history.mjs").replace(/\\/g, "/");
    const syncHookLine = `CODEX_HISTORY_SYNC_GIT_HOOK=1 "${nodePath}" "${workerPath}" pull --no-pull --no-commit >/dev/null 2>&1 || true`;
    await fs.writeFile(path.join(hooksRoot, "post-merge"), `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 && git lfs post-merge "$@"\n${syncHookLine}\n`, "utf8");
    await fs.writeFile(path.join(hooksRoot, "post-rewrite"), `#!/bin/sh\n${syncHookLine}\n`, "utf8");
    await fs.writeFile(path.join(hooksRoot, "pre-commit"), `#!/bin/sh\nset -eu\nblocked='(^|/)(auth\\.json|config\\.toml|.*\\.sqlite(-wal|-shm)?|\\.codex-global-state\\.json)$'\nif git diff --cached --name-only | grep -E "$blocked" >/dev/null 2>&1; then\n  echo "Refusing commit: sensitive Codex runtime files are staged." >&2\n  exit 1\nfi\n`, "utf8");
    const attributesPath = path.join(dataRepoRoot, ".gitattributes");
    const requiredAttributes = [
      "data/sessions/**/*.jsonl filter=lfs diff=lfs merge=lfs -text",
      "data/archived_sessions/**/*.jsonl filter=lfs diff=lfs merge=lfs -text",
      "data/session_index.jsonl text eol=lf",
      "data/archive-events/**/*.json text eol=lf"
    ];
    const existingAttributes = await fs.readFile(attributesPath, "utf8").catch(() => "");
    const attributeLines = new Set(existingAttributes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    for (const line of requiredAttributes) attributeLines.add(line);
    await fs.writeFile(attributesPath, `${[...attributeLines].join("\n")}\n`, "utf8");
    const ignorePath = path.join(dataRepoRoot, ".gitignore");
    if (!(await exists(ignorePath))) await fs.writeFile(ignorePath, ".sync/\nconflicts/\n", "utf8");
    const hooks = await run("git", ["config", "core.hooksPath", ".githooks"], { cwd: dataRepoRoot });
    if (hooks.code !== 0) throw new Error(`git hooks configuration failed: ${hooks.stderr || hooks.stdout}`);
  }
}

export async function installWindowsLogonTask(repoRoot) {
  if (process.platform !== "win32") return { skipped: true, reason: "not-windows" };
  const scriptPath = path.join(repoRoot, "bin", "register-logon-task.ps1");
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-RepoRoot", repoRoot, "-NodePath", process.execPath], { cwd: repoRoot });
  if (result.code !== 0) throw new Error(`logon task installation failed: ${result.stderr || result.stdout}`);
  return { skipped: false };
}
