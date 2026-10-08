import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandUserPath, readToolConfig } from "./config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (value) => path.win32.normalize(String(value).replace(/^\\\\\?\\/, "")).toLowerCase();
const within = (value, root) => value === root || value.startsWith(`${root.replace(/[\\/]+$/, "")}\\`);

export function matchHomeProcesses(home, processes, previous = []) {
  const roots = [...(home.runtimeProcessPaths ?? []), ...(home.uiStateExitProcessPaths ?? []), path.join(home.path, "runtime", "codex-mirror")]
    .map((value) => normalize(expandUserPath(value, repoRoot)));
  const client = home.clientExecutable ? normalize(expandUserPath(home.clientExecutable, repoRoot)) : null;
  const markers = [...(home.runtimeCommandLineContains ?? []), ...(home.uiStateExitCommandLineContains ?? [])].map((value) => String(value).toLowerCase());
  const identity = (p) => ({ ProcessId: p.ProcessId, CreationDate: p.CreationDate });
  const backends = processes.filter((p) => {
    const executable = normalize(p.ExecutablePath ?? "");
    const command = String(p.CommandLine ?? "").toLowerCase();
    return roots.some((root) => within(executable, root)) && command.includes("app-server") &&
      (markers.length === 0 || markers.some((marker) => command.includes(marker)));
  });
  const desktops = processes.filter((p) => {
    const isMain = /^(chatgpt|codex)\.exe$/i.test(p.Name ?? "") && !String(p.CommandLine ?? "").includes("--type=") && !String(p.CommandLine ?? "").includes("app-server");
    return isMain && (backends.some((backend) => backend.ParentProcessId === p.ProcessId) ||
      previous.some((prior) => prior.ProcessId === p.ProcessId && prior.CreationDate === p.CreationDate));
  });
  const launchers = processes.filter((p) => client && normalize(p.ExecutablePath ?? "") === client);
  return { known: true, running: backends.length + desktops.length + launchers.length > 0,
    backendCount: backends.length, desktopCount: desktops.length, launcherCount: launchers.length,
    processes: [...backends, ...desktops, ...launchers].map(identity), trackedDesktops: desktops.map(identity) };
}

export async function readHomeRuntime(home, previous = []) {
  if (process.platform !== "win32") return { known: false, reason: "unsupported-platform" };
  if (!home.clientExecutable && !(home.runtimeProcessPaths?.length || home.uiStateExitProcessPaths?.length) && !fs.existsSync(path.join(home.path, "runtime", "codex-mirror"))) {
    return { known: false, reason: "runtime-paths-unconfigured" };
  }
  try {
    const output = await new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const parsed = JSON.parse(output);
    return matchHomeProcesses(home, Array.isArray(parsed) ? parsed : [parsed], previous);
  } catch (error) { return { known: false, reason: "process-query-failed", error: error.message }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { config } = await readToolConfig(repoRoot);
  const home = config.homes.find((entry) => entry.name === process.argv[2]);
  if (!home) throw new Error("Unknown home");
  const previous = process.argv[3] ? JSON.parse(Buffer.from(process.argv[3], "base64").toString()) : [];
  const result = await readHomeRuntime(home, previous);
  console.log(JSON.stringify(result));
  if (!result.known) process.exitCode = 1;
}
