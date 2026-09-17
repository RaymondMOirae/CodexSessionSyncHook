#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { applyUiMetadata, collectUiMetadata } from "./ui-metadata.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "sync.config.json");
let dataRepoRoot = repoRoot;
let stateDir = path.join(dataRepoRoot, ".sync");
let lockPath = path.join(stateDir, "sync.lock");
let logPath = path.join(stateDir, "sync.log");
let conflictRoot = path.join(dataRepoRoot, "conflicts");
let canonicalRoots = {
  sessions: path.join(dataRepoRoot, "data", "sessions"),
  archived_sessions: path.join(dataRepoRoot, "data", "archived_sessions")
};

const args = process.argv.slice(2);
let command = args[0] ?? "sync";
if (command === "run") command = args[1] ?? "sync";
const hasFlag = (name) => args.includes(name);

function normalizePath(value) {
  let normalized = String(value ?? "").replace(/^\\\\\?\\/, "");
  if (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")) {
    return path.win32.normalize(normalized).toLowerCase();
  }
  return path.posix.normalize(normalized.replaceAll("\\", "/"));
}

function timestamp() {
  return new Date().toISOString();
}

async function log(message) {
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.appendFile(logPath, `[${timestamp()}] ${message}\n`, "utf8");
}

function run(program, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig() {
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  if (!Array.isArray(config.homes) || config.homes.length < 1) throw new Error("sync.config.json must define at least one home.");
  const expandPath = (value) => {
    const raw = String(value ?? "");
    if (raw === "~") return process.env.USERPROFILE || process.env.HOME || raw;
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      const userHome = process.env.USERPROFILE || process.env.HOME;
      if (!userHome) throw new Error(`Cannot expand home path: ${raw}`);
      return path.join(userHome, raw.slice(2));
    }
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repoRoot, raw);
  };
  const names = new Set();
  const paths = new Set();
  config.homes = config.homes.map((home, index) => {
    const name = String(home.name ?? `home-${index + 1}`).trim();
    const homePath = expandPath(home.path);
    if (!name) throw new Error(`Home at index ${index} has no name.`);
    if (names.has(name)) throw new Error(`Duplicate home name: ${name}`);
    if (paths.has(homePath.toLowerCase())) throw new Error(`Duplicate home path: ${homePath}`);
    names.add(name);
    paths.add(homePath.toLowerCase());
    return { ...home, name, path: homePath, installHooks: home.installHooks !== false };
  });
  config.git ??= {};
  config.git.dataRepository = expandPath(config.git.dataRepository ?? ".");
  config.git.remote ??= "origin";
  config.git.branch ??= "main";
  config.sync ??= {};
  config.sync.lockStaleMinutes ??= 30;
  config.sync.settleMilliseconds ??= 1500;
  config.sync.stripEncryptedContent ??= true;
  dataRepoRoot = config.git.dataRepository;
  stateDir = path.join(dataRepoRoot, ".sync");
  lockPath = path.join(stateDir, "sync.lock");
  logPath = path.join(stateDir, "sync.log");
  conflictRoot = path.join(dataRepoRoot, "conflicts");
  canonicalRoots = {
    sessions: path.join(dataRepoRoot, "data", "sessions"),
    archived_sessions: path.join(dataRepoRoot, "data", "archived_sessions")
  };
  return config;
}

async function acquireLock(staleMinutes) {
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    const handle = await fsp.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: timestamp() }));
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fsp.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > staleMinutes * 60_000) {
      await fsp.rm(lockPath, { force: true });
      return acquireLock(staleMinutes);
    }
    return null;
  }
}

async function releaseLock(handle) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await fsp.rm(lockPath, { force: true }).catch(() => {});
}

async function walkFiles(root, extension = null) {
  if (!(await exists(root))) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) files.push(full);
    }
  }
  return files;
}

async function activeThreadIds(homePath) {
  const lockRoot = path.join(homePath, "thread-writer-locks");
  const result = new Set();
  if (!(await exists(lockRoot))) return result;
  for (const entry of await fsp.readdir(lockRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".lock") || entry.name.startsWith(".")) continue;
    const handle = await fsp.open(path.join(lockRoot, entry.name), "r+").catch(() => null);
    if (handle) {
      await handle.close();
      continue;
    }
    result.add(entry.name.slice(0, -".lock".length));
  }
  return result;
}

async function likelyActiveThreadIds(homePath) {
  const result = await activeThreadIds(homePath);
  const newestCutoff = Date.now() - 5 * 60_000;
  for (const bucket of ["sessions", "archived_sessions"]) {
    const root = path.join(homePath, bucket);
    for (const filePath of await walkFiles(root, ".jsonl")) {
      const stat = await fsp.stat(filePath);
      if (stat.mtimeMs < newestCutoff) continue;
      const meta = await readSessionMeta(filePath);
      if (meta?.id) result.add(meta.id);
    }
  }
  return result;
}

async function readFirstLine(filePath, maxBytes = 1024 * 1024) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    const newline = data.indexOf(0x0a);
    return data.subarray(0, newline >= 0 ? newline : bytesRead).toString("utf8").replace(/\r$/, "");
  } finally {
    await handle.close();
  }
}

async function readSessionMeta(filePath) {
  try {
    const parsed = JSON.parse(await readFirstLine(filePath));
    const payload = parsed?.payload ?? parsed;
    const id = payload?.id ?? payload?.session_id ?? payload?.thread_id;
    if (typeof id !== "string" || !id) return null;
    return {
      id,
      provider: typeof payload.model_provider === "string" ? payload.model_provider : null,
      timestamp: typeof payload.timestamp === "string" ? payload.timestamp : null
    };
  } catch {
    return null;
  }
}

function normalizeProviderInFirstLine(line) {
  try {
    const value = JSON.parse(line);
    const payload = value?.payload ?? value;
    if (payload && Object.prototype.hasOwnProperty.call(payload, "model_provider")) {
      payload.model_provider = "__SYNC_PROVIDER__";
    }
    return JSON.stringify(value);
  } catch {
    return line;
  }
}

function removeEncryptedContent(value) {
  if (Array.isArray(value)) return value.map(removeEncryptedContent);
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (key === "encrypted_content") delete value[key];
    else value[key] = removeEncryptedContent(value[key]);
  }
  return value;
}

function normalizePortableLine(line, { firstLine = false, targetProvider = null, stripEncryptedContent = true } = {}) {
  const needsProviderRewrite = firstLine && targetProvider !== null;
  const needsEncryptedContentStrip = stripEncryptedContent && line.includes('"encrypted_content"');
  if (!needsProviderRewrite && !needsEncryptedContentStrip) return line;
  try {
    const value = JSON.parse(line);
    const payload = value?.payload ?? value;
    if (needsProviderRewrite && payload && Object.prototype.hasOwnProperty.call(payload, "model_provider")) {
      payload.model_provider = targetProvider;
    }
    if (needsEncryptedContentStrip) removeEncryptedContent(value);
    return JSON.stringify(value);
  } catch {
    return line;
  }
}

async function transformedLines(filePath, options = {}) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let firstLine = true;
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const line of lines) {
          yield normalizePortableLine(line, { ...options, firstLine });
          firstLine = false;
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
  };
}

async function fileContainsEncryptedContent(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.includes('"encrypted_content"')) return true;
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function rewriteProviderInFirstLine(line, targetProvider) {
  const value = JSON.parse(line);
  const payload = value?.payload ?? value;
  if (payload && Object.prototype.hasOwnProperty.call(payload, "model_provider")) {
    payload.model_provider = targetProvider;
  }
  return JSON.stringify(value);
}

function providerFromFirstLine(line) {
  try {
    const value = JSON.parse(line);
    const payload = value?.payload ?? value;
    return typeof payload?.model_provider === "string" ? payload.model_provider : null;
  } catch {
    return null;
  }
}

async function readConfiguredProvider(homePath) {
  const text = await fsp.readFile(path.join(homePath, "config.toml"), "utf8").catch(() => "");
  const beforeFirstTable = text.split(/^\s*\[/m, 1)[0];
  const match = beforeFirstTable.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/m);
  return match?.[1] ?? "openai";
}

async function discoverCodexExecutable(homePath) {
  const configText = await fsp.readFile(path.join(homePath, "config.toml"), "utf8").catch(() => "");
  const configured = configText.match(/^\s*CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]\s*$/m)?.[1];
  const candidates = process.platform === "win32"
    ? [path.join(homePath, "runtime", "codex-mirror", "codex.exe"), configured, process.env.CODEX_CLI_PATH, "codex.exe", "codex"]
    : [path.join(homePath, "runtime", "codex-mirror", "codex"), configured, process.env.CODEX_CLI_PATH, "codex"];
  for (const candidate of candidates.filter(Boolean)) {
    if (!path.isAbsolute(candidate) || await exists(candidate)) return candidate;
  }
  return null;
}

async function refreshThreadIndex(config, home) {
  if (config.sync.refreshThreadIndex === false) return { skipped: true, reason: "disabled" };
  const executable = await discoverCodexExecutable(home.path);
  if (!executable) return { skipped: true, reason: "codex-cli-not-found" };
  const timeoutMs = Math.max(10, Number(config.sync.indexRefreshTimeoutSeconds ?? 120)) * 1000;
  return new Promise((resolve) => {
    const child = spawn(executable, ["app-server"], {
      cwd: repoRoot,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: home.path }
    });
    let buffer = "";
    let stderr = "";
    let requestId = 0;
    let pageCount = 0;
    let threadCount = 0;
    let archived = false;
    let cursor = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const requestPage = () => send({
      method: "thread/list",
      id: ++requestId,
      params: { limit: 100, archived, useStateDbOnly: false, ...(cursor ? { cursor } : {}) }
    });
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout", pageCount, threadCount }), timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 0) {
          if (message.error) return finish({ ok: false, reason: "initialize-failed", error: message.error });
          send({ method: "initialized", params: {} });
          requestPage();
          continue;
        }
        if (message.id !== requestId) continue;
        if (message.error) return finish({ ok: false, reason: "thread-list-failed", error: message.error });
        pageCount += 1;
        threadCount += Array.isArray(message.result?.data) ? message.result.data.length : 0;
        cursor = message.result?.nextCursor ?? null;
        if (cursor) requestPage();
        else if (!archived) {
          archived = true;
          requestPage();
        } else finish({ ok: true, pageCount, threadCount });
      }
    });
    child.on("error", (error) => finish({ ok: false, reason: "spawn-failed", error: error.message }));
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, reason: "server-exited", code, stderr: stderr.trim() });
    });
    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "codex_history_sync", title: "Codex History Sync", version: "1.0.0" } }
    });
  });
}

function normalizedFirstLineBuffer(buffer) {
  const newline = buffer.indexOf(0x0a);
  const first = buffer.subarray(0, newline >= 0 ? newline : buffer.length).toString("utf8").replace(/\r$/, "");
  const normalized = Buffer.from(normalizeProviderInFirstLine(first), "utf8");
  const tail = newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0);
  return { normalized, tail };
}

async function canonicalDigest(filePath, stripEncryptedContent = true) {
  const hash = crypto.createHash("sha256");
  for await (const line of await transformedLines(filePath, { targetProvider: "__SYNC_PROVIDER__", stripEncryptedContent })) {
    hash.update(line);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function providerAgnosticPrefix(longerPath, shorterPath, stripEncryptedContent = true) {
  const longer = (await transformedLines(longerPath, { targetProvider: "__SYNC_PROVIDER__", stripEncryptedContent }))[Symbol.asyncIterator]();
  const shorter = (await transformedLines(shorterPath, { targetProvider: "__SYNC_PROVIDER__", stripEncryptedContent }))[Symbol.asyncIterator]();
  for (;;) {
    const shortLine = await shorter.next();
    if (shortLine.done) return true;
    const longLine = await longer.next();
    if (longLine.done || longLine.value !== shortLine.value) return false;
  }
}

async function copyAtomic(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(source, temp);
  await fsp.rename(temp, destination).catch(async () => {
    await fsp.rm(destination, { force: true });
    await fsp.rename(temp, destination);
  });
}

async function copySessionForProvider(source, destination, targetProvider, stripEncryptedContent = true) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const output = fs.createWriteStream(temp, { encoding: "utf8", flags: "wx" });
  try {
    for await (const line of await transformedLines(source, { targetProvider, stripEncryptedContent })) {
      if (!output.write(`${line}\n`)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
    await fsp.rename(temp, destination).catch(async () => {
      await fsp.rm(destination, { force: true });
      await fsp.rename(temp, destination);
    });
  } catch (error) {
    output.destroy();
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function destinationMatches(destination, expectedDigest, targetProvider, stripEncryptedContent = true) {
  if (!(await exists(destination))) return false;
  if (stripEncryptedContent && await fileContainsEncryptedContent(destination)) return false;
  if (await canonicalDigest(destination, stripEncryptedContent) !== expectedDigest) return false;
  return providerFromFirstLine(await readFirstLine(destination)) === targetProvider;
}

async function buildIndex(root, bucket) {
  const index = new Map();
  for (const filePath of await walkFiles(root, ".jsonl")) {
    const meta = await readSessionMeta(filePath);
    if (!meta) {
      await log(`skip invalid rollout: ${filePath}`);
      continue;
    }
    const stat = await fsp.stat(filePath);
    const candidate = { filePath, bucket, meta, stat, allPaths: [filePath] };
    const current = index.get(meta.id);
    if (!current) {
      index.set(meta.id, candidate);
    } else if (candidate.stat.mtimeMs > current.stat.mtimeMs || (candidate.stat.mtimeMs === current.stat.mtimeMs && candidate.stat.size > current.stat.size)) {
      candidate.allPaths = [...(current.allPaths ?? [current.filePath]), filePath];
      index.set(meta.id, candidate);
    } else {
      current.allPaths = [...(current.allPaths ?? [current.filePath]), filePath];
    }
  }
  return index;
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; }
}

function observedArchiveStates(candidatesById, sourceName) {
  const states = new Map();
  for (const [id, candidates] of candidatesById) {
    const buckets = new Set(candidates.filter((candidate) => candidate.sourceName === sourceName).map((candidate) => candidate.bucket));
    if (buckets.has("archived_sessions")) states.set(id, true);
    else if (buckets.has("sessions")) states.set(id, false);
  }
  return states;
}

function archiveObservationPath(home) {
  const key = crypto.createHash("sha256").update(`${home.name}\0${home.path}`).digest("hex").slice(0, 16);
  return path.join(stateDir, "archive-observations", `${home.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${key}.json`);
}

async function archiveDeviceId() {
  const deviceIdPath = path.join(stateDir, "device-id");
  const current = (await fsp.readFile(deviceIdPath, "utf8").catch(() => "")).trim();
  if (current) return current;
  const created = crypto.randomUUID();
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(deviceIdPath, `${created}\n`, { encoding: "utf8", flag: "wx" }).catch(() => {});
  return (await fsp.readFile(deviceIdPath, "utf8").catch(() => created)).trim() || created;
}

async function sqliteArchiveStates(home) {
  const dbPath = [path.join(home.path, "state_5.sqlite"), path.join(home.path, "sqlite", "state_5.sqlite")].find((candidate) => fs.existsSync(candidate));
  if (!dbPath) return new Map();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return new Map(db.prepare("SELECT id, archived FROM threads").all().map((row) => [row.id, Boolean(row.archived)]));
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

async function readHomeArchiveStates(home, candidatesById) {
  const states = observedArchiveStates(candidatesById, home.name);
  const databaseStates = await sqliteArchiveStates(home);
  for (const [id, archived] of databaseStates) if (states.has(id)) states.set(id, archived);
  return states;
}

function newerArchiveEvent(current, candidate) {
  if (!current) return candidate;
  if (candidate.observedAtMs !== current.observedAtMs) return candidate.observedAtMs > current.observedAtMs ? candidate : current;
  if (candidate.archived !== current.archived) return candidate.archived ? candidate : current;
  return String(candidate.source).localeCompare(String(current.source)) > 0 ? candidate : current;
}

async function loadArchiveEvents() {
  const root = path.join(dataRepoRoot, "data", "archive-events");
  const latest = new Map();
  for (const filePath of await walkFiles(root, ".json")) {
    const event = await readJson(filePath, null);
    if (typeof event?.id !== "string" || typeof event?.archived !== "boolean") continue;
    const observedAtMs = Number(event.observedAtMs) || Date.parse(event.observedAt ?? "") || 0;
    const normalized = { id: event.id, archived: event.archived, observedAtMs, source: event.source ?? "unknown" };
    latest.set(event.id, newerArchiveEvent(latest.get(event.id), normalized));
  }
  return latest;
}

async function appendArchiveEvent(event) {
  const safeId = event.id.replace(/[^A-Za-z0-9._-]/g, "_");
  const root = path.join(dataRepoRoot, "data", "archive-events", safeId);
  await fsp.mkdir(root, { recursive: true });
  const fileName = `${String(event.observedAtMs).padStart(13, "0")}-${event.source.replace(/[^A-Za-z0-9._-]/g, "_")}-${crypto.randomUUID()}.json`;
  await fsp.writeFile(path.join(root, fileName), `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function resolveArchiveStates(config, candidatesById) {
  const deviceId = await archiveDeviceId();
  const latestEvents = await loadArchiveEvents();
  const observations = new Map();
  const snapshots = new Map();
  for (const home of config.homes) {
    observations.set(home.name, await readHomeArchiveStates(home, candidatesById));
    snapshots.set(home.name, (await readJson(archiveObservationPath(home), { states: {} })).states ?? {});
  }
  const canonicalObserved = observedArchiveStates(candidatesById, "git");
  const ids = new Set([...candidatesById.keys(), ...latestEvents.keys()]);
  const changedIds = new Set();
  let eventsWritten = 0;
  for (const id of ids) {
    const localChanges = [];
    const initialStates = [];
    for (const home of config.homes) {
      const actual = observations.get(home.name).get(id);
      if (typeof actual !== "boolean") continue;
      initialStates.push(actual);
      const prior = snapshots.get(home.name)[id];
      if (typeof prior === "boolean" && prior !== actual && latestEvents.get(id)?.archived !== actual) localChanges.push({ home: home.name, archived: actual });
    }
    if (canonicalObserved.has(id)) initialStates.push(canonicalObserved.get(id));
    if (localChanges.length > 0) {
      const values = new Set(localChanges.map((entry) => entry.archived));
      const archived = values.size === 1 ? localChanges[0].archived : true;
      const observedAtMs = Math.max(Date.now(), (latestEvents.get(id)?.observedAtMs ?? 0) + 1);
      const source = values.size === 1 ? localChanges.map((entry) => entry.home).sort().join(",") : "conflict:archive-wins";
      const event = { schemaVersion: 1, id, archived, observedAt: new Date(observedAtMs).toISOString(), observedAtMs, source: `${deviceId}:${source}` };
      await appendArchiveEvent(event);
      latestEvents.set(id, newerArchiveEvent(latestEvents.get(id), event));
      eventsWritten += 1;
      changedIds.add(id);
    } else if (!latestEvents.has(id) && initialStates.length > 0) {
      const observedAtMs = Date.now();
      const event = { schemaVersion: 1, id, archived: initialStates.some(Boolean), observedAt: new Date(observedAtMs).toISOString(), observedAtMs, source: `${deviceId}:bootstrap` };
      await appendArchiveEvent(event);
      latestEvents.set(id, event);
      eventsWritten += 1;
    }
  }
  const archivedById = new Map([...latestEvents].map(([id, event]) => [id, event.archived]));
  const needsApplyIds = new Set();
  for (const [id, archived] of archivedById) {
    if (canonicalObserved.has(id) && canonicalObserved.get(id) !== archived) needsApplyIds.add(id);
    for (const observed of observations.values()) if (observed.has(id) && observed.get(id) !== archived) needsApplyIds.add(id);
  }
  return {
    archivedById,
    observations,
    changedIds,
    needsApplyIds,
    eventsWritten
  };
}

async function writeArchiveState(config, archiveState) {
  for (const home of config.homes) {
    const observed = archiveState.observations.get(home.name) ?? new Map();
    const snapshotPath = archiveObservationPath(home);
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsp.writeFile(snapshotPath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt: timestamp(),
      states: Object.fromEntries(observed)
    }, null, 2)}\n`, "utf8");
  }
}

async function writeArchiveSnapshots(config, statesByHome) {
  for (const home of config.homes) {
    const snapshotPath = archiveObservationPath(home);
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsp.writeFile(snapshotPath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt: timestamp(),
      states: Object.fromEntries(statesByHome.get(home.name) ?? new Map())
    }, null, 2)}\n`, "utf8");
  }
}

function normalizeExistingPath(filePath) {
  return process.platform === "win32" ? String(filePath ?? "").replace(/^\\\\\?\\/, "") : String(filePath ?? "");
}

async function synchronizeArchiveDatabase(home, archivedById, candidatesById) {
  const dbPath = [path.join(home.path, "state_5.sqlite"), path.join(home.path, "sqlite", "state_5.sqlite")].find((candidate) => fs.existsSync(candidate));
  if (!dbPath) return { skipped: true, reason: "state-db-not-found" };
  const { DatabaseSync, backup: sqliteBackup } = await import("node:sqlite");
  const desiredRows = [];
  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const row of readDb.prepare("SELECT id, archived, rollout_path FROM threads").all()) {
      if (!archivedById.has(row.id)) continue;
      const archived = archivedById.get(row.id);
      const desiredBucket = archived ? "archived_sessions" : "sessions";
      const rolloutPath = (candidatesById.get(row.id) ?? []).find((candidate) => candidate.sourceName === home.name && candidate.bucket === desiredBucket)?.filePath;
      if (!rolloutPath) continue;
      if (Boolean(row.archived) !== archived || normalizePath(row.rollout_path) !== normalizePath(rolloutPath)) desiredRows.push({ id: row.id, archived, rolloutPath });
    }
  } finally {
    readDb.close();
  }
  if (desiredRows.length === 0) return { ok: true, updates: 0 };

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupRoot = path.join(home.path, "backups_state", "archive-state", stamp);
  await fsp.mkdir(backupRoot, { recursive: true });
  const backupDb = new DatabaseSync(dbPath, { readOnly: true });
  try { await sqliteBackup(backupDb, path.join(backupRoot, "state_5.sqlite")); } finally { backupDb.close(); }

  const db = new DatabaseSync(dbPath);
  let updates = 0;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const update = db.prepare("UPDATE threads SET archived = ?, archived_at = CASE WHEN ? = 1 THEN COALESCE(archived_at, CAST(strftime('%s','now') AS INTEGER)) ELSE NULL END, rollout_path = ? WHERE id = ? AND (archived <> ? OR rollout_path <> ?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of desiredRows) {
        const result = update.run(row.archived ? 1 : 0, row.archived ? 1 : 0, row.rolloutPath, row.id, row.archived ? 1 : 0, row.rolloutPath);
        updates += Number(result.changes ?? 0);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return { ok: true, updates, backupDir: backupRoot };
}

function rolloutPathMatchesBucket(home, rolloutPath, bucket) {
  if (typeof rolloutPath !== "string" || !rolloutPath) return false;
  const normalizedPath = normalizePath(rolloutPath);
  const normalizedRoot = normalizePath(path.join(home.path, bucket));
  const separator = process.platform === "win32" ? "\\" : "/";
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${separator}`);
}

async function archiveStatesMatchDatabases(config, archivedById) {
  for (const home of config.homes) {
    const dbPath = [path.join(home.path, "state_5.sqlite"), path.join(home.path, "sqlite", "state_5.sqlite")].find((candidate) => fs.existsSync(candidate));
    if (!dbPath) continue;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        for (const row of db.prepare("SELECT id, archived, rollout_path FROM threads").all()) {
          if (!archivedById.has(row.id)) continue;
          const archived = archivedById.get(row.id);
          const desiredBucket = archived ? "archived_sessions" : "sessions";
          if (Boolean(row.archived) !== archived || !rolloutPathMatchesBucket(home, row.rollout_path, desiredBucket) || !fs.existsSync(normalizeExistingPath(row.rollout_path))) return false;
        }
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function moveOppositeCopies(candidates, sourceName, sourceRoot, desiredBucket, keepPath) {
  let moves = 0;
  for (const candidate of candidates) {
    if (candidate.sourceName !== sourceName || candidate.bucket === desiredBucket) continue;
    for (const filePath of candidate.allPaths ?? [candidate.filePath]) {
      if (path.resolve(filePath) === path.resolve(keepPath)) continue;
      const meta = await readSessionMeta(filePath);
      const stat = await fsp.stat(filePath);
      const relative = desiredBucket === "sessions"
        ? chooseCanonicalRelative({ bucket: "sessions", filePath, meta: meta ?? candidate.meta, stat })
        : path.basename(filePath);
      let destination = path.join(sourceRoot, desiredBucket, relative);
      if (await exists(destination)) {
        if (await canonicalDigest(destination) === await canonicalDigest(filePath)) {
          await fsp.rm(filePath, { force: true });
          moves += 1;
          continue;
        }
        const extension = path.extname(destination);
        const suffix = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 8);
        destination = `${destination.slice(0, -extension.length)}-${suffix}${extension}`;
      }
      await copyAtomic(filePath, destination);
      await fsp.rm(filePath, { force: true });
      moves += 1;
    }
  }
  return moves;
}

function chooseCanonicalRelative(candidate) {
  if (candidate.bucket === "archived_sessions") return candidate.stat.name ?? path.basename(candidate.filePath);
  const date = candidate.meta.timestamp ? new Date(candidate.meta.timestamp) : new Date(candidate.stat.mtimeMs);
  const goodDate = Number.isFinite(date.getTime()) ? date : new Date(candidate.stat.mtimeMs);
  return path.join(String(goodDate.getUTCFullYear()), String(goodDate.getUTCMonth() + 1).padStart(2, "0"), String(goodDate.getUTCDate()).padStart(2, "0"), path.basename(candidate.filePath));
}

async function collectAllCandidates(config) {
  const grouped = new Map();
  const sources = [];
  for (const home of config.homes) {
    sources.push({ name: home.name, root: path.join(home.path, "sessions"), bucket: "sessions" });
    if (config.sync.includeArchived) sources.push({ name: home.name, root: path.join(home.path, "archived_sessions"), bucket: "archived_sessions" });
  }
  sources.push({ name: "git", root: canonicalRoots.sessions, bucket: "sessions", canonical: true });
  if (config.sync.includeArchived) sources.push({ name: "git", root: canonicalRoots.archived_sessions, bucket: "archived_sessions", canonical: true });

  for (const source of sources) {
    const index = await buildIndex(source.root, source.bucket);
    for (const [id, candidate] of index) {
      const list = grouped.get(id) ?? [];
      list.push({ ...candidate, sourceName: source.name, canonical: Boolean(source.canonical) });
      grouped.set(id, list);
    }
  }
  return grouped;
}

async function collectActiveThreadIds(config) {
  const active = new Set();
  for (const home of config.homes) {
    for (const id of await likelyActiveThreadIds(home.path)) active.add(id);
  }
  return active;
}

async function collectLockedThreadIds(config) {
  const locked = new Set();
  for (const home of config.homes) {
    for (const id of await activeThreadIds(home.path)) locked.add(id);
  }
  return locked;
}

async function selectWinner(id, candidates, stripEncryptedContent = true) {
  const enriched = [];
  for (const candidate of candidates) enriched.push({ ...candidate, digest: await canonicalDigest(candidate.filePath, stripEncryptedContent) });
  const digestGroups = new Map();
  for (const candidate of enriched) {
    const list = digestGroups.get(candidate.digest) ?? [];
    list.push(candidate);
    digestGroups.set(candidate.digest, list);
  }
  if (digestGroups.size === 1) {
    return enriched.sort((a, b) => Number(b.canonical) - Number(a.canonical) || b.stat.mtimeMs - a.stat.mtimeMs || b.stat.size - a.stat.size)[0];
  }

  // Raw file size is not a safe ordering when portable copies omit
  // provider-bound encrypted_content. Find the candidate whose normalized
  // history contains every other candidate instead.
  const ordered = enriched.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.stat.size - a.stat.size);
  for (const possibleWinner of ordered) {
    let containsAll = true;
    for (const candidate of ordered) {
      if (candidate === possibleWinner) continue;
      if (!(await providerAgnosticPrefix(possibleWinner.filePath, candidate.filePath, stripEncryptedContent))) {
        containsAll = false;
        break;
      }
    }
    if (containsAll) return possibleWinner;
  }

  await fsp.mkdir(path.join(conflictRoot, id), { recursive: true });
  for (const candidate of enriched) {
    const safeName = `${candidate.sourceName}-${candidate.bucket}-${path.basename(candidate.filePath)}`.replace(/[^A-Za-z0-9._-]/g, "_");
    await copyAtomic(candidate.filePath, path.join(conflictRoot, id, safeName));
  }
  await fsp.writeFile(path.join(conflictRoot, id, "conflict.json"), JSON.stringify({ id, detectedAt: timestamp(), candidates: enriched.map((candidate) => ({ source: candidate.sourceName, bucket: candidate.bucket, file: candidate.filePath, size: candidate.stat.size, modifiedAt: candidate.stat.mtime.toISOString(), digest: candidate.digest })) }, null, 2));
  await log(`conflict ${id}: preserved ${enriched.length} variants`);
  return null;
}

async function mergeSessionIndex(config) {
  if (!config.sync.includeSessionIndex) return;
  const files = [path.join(dataRepoRoot, "data", "session_index.jsonl"), ...config.homes.map((home) => path.join(home.path, "session_index.jsonl"))];
  const latest = new Map();
  for (const filePath of files) {
    if (!(await exists(filePath))) continue;
    const text = await fsp.readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.id !== "string" || typeof entry.thread_name !== "string") continue;
        const key = entry.id;
        const stamp = Date.parse(entry.updated_at ?? "") || 0;
        const current = latest.get(key);
        if (!current || stamp >= current.stamp) latest.set(key, { entry, stamp });
      } catch {}
    }
  }
  const output = [...latest.values()].sort((a, b) => a.entry.id.localeCompare(b.entry.id)).map(({ entry }) => JSON.stringify(entry)).join("\n") + (latest.size ? "\n" : "");
  const canonical = path.join(dataRepoRoot, "data", "session_index.jsonl");
  await fsp.mkdir(path.dirname(canonical), { recursive: true });
  await fsp.writeFile(canonical, output, "utf8");
  for (const home of config.homes) await fsp.writeFile(path.join(home.path, "session_index.jsonl"), output, "utf8");
}

async function synchronizeFiles(config) {
  const grouped = await collectAllCandidates(config);
  const archiveState = config.sync.includeArchived === false
    ? { archivedById: new Map(), observations: new Map(), changedIds: new Set(), needsApplyIds: new Set(), eventsWritten: 0, disabled: true }
    : await resolveArchiveStates(config, grouped);
  const active = await collectActiveThreadIds(config);
  const locked = await collectLockedThreadIds(config);
  const homeProviders = new Map();
  for (const home of config.homes) homeProviders.set(home.name, await readConfiguredProvider(home.path));
  let copiedToCanonical = 0;
  let copiedToHomes = 0;
  let conflicts = 0;
  let archiveMoves = 0;
  for (const [id, candidates] of grouped) {
    const archiveTransition = archiveState.changedIds.has(id) || archiveState.needsApplyIds.has(id);
    if (active.has(id) && (!archiveTransition || locked.has(id))) {
      await log(`defer active session ${id}`);
      continue;
    }
    const winner = await selectWinner(id, candidates, config.sync.stripEncryptedContent);
    if (!winner) {
      conflicts += 1;
      continue;
    }
    const desiredBucket = archiveState.disabled ? winner.bucket : archiveState.archivedById.get(id) ? "archived_sessions" : "sessions";
    const bucketRoot = canonicalRoots[desiredBucket];
    const relative = desiredBucket === "sessions" ? chooseCanonicalRelative({ ...winner, bucket: "sessions" }) : path.basename(winner.filePath);
    let canonicalPath = path.join(bucketRoot, relative);
    if (await exists(canonicalPath)) {
      const existingMeta = await readSessionMeta(canonicalPath);
      if (existingMeta?.id && existingMeta.id !== id) {
        const extension = path.extname(canonicalPath);
        canonicalPath = `${canonicalPath.slice(0, -extension.length)}-${id}${extension}`;
      }
    }
    const winnerCanonicalDigest = await canonicalDigest(winner.filePath, false);
    if (!(await exists(canonicalPath)) || await canonicalDigest(canonicalPath, false) !== winnerCanonicalDigest) {
      await copyAtomic(winner.filePath, canonicalPath);
      copiedToCanonical += 1;
    }
    for (const candidate of candidates.filter((entry) => entry.sourceName === "git" && entry.bucket === desiredBucket)) {
      for (const filePath of candidate.allPaths ?? [candidate.filePath]) {
        if (path.resolve(filePath) === path.resolve(canonicalPath)) continue;
        if (await canonicalDigest(filePath, config.sync.stripEncryptedContent) === await canonicalDigest(canonicalPath, config.sync.stripEncryptedContent)) await fsp.rm(filePath, { force: true });
      }
    }
    archiveMoves += await moveOppositeCopies(candidates, "git", path.join(dataRepoRoot, "data"), desiredBucket, canonicalPath);
    for (const home of config.homes) {
      let destination = desiredBucket === "sessions"
        ? path.join(home.path, "sessions", relative)
        : path.join(home.path, "archived_sessions", path.basename(canonicalPath));
      if (await exists(destination)) {
        const existingMeta = await readSessionMeta(destination);
        if (existingMeta?.id && existingMeta.id !== id) {
          const extension = path.extname(destination);
          destination = `${destination.slice(0, -extension.length)}-${id}${extension}`;
        }
      }
      const targetProvider = homeProviders.get(home.name);
      const stripForTarget = config.sync.stripEncryptedContent && winner.meta.provider !== targetProvider;
      const expectedDestinationDigest = await canonicalDigest(canonicalPath, stripForTarget);
      if (!(await destinationMatches(destination, expectedDestinationDigest, targetProvider, stripForTarget))) {
        await copySessionForProvider(canonicalPath, destination, targetProvider, stripForTarget);
        copiedToHomes += 1;
      }
      for (const candidate of candidates.filter((entry) => entry.sourceName === home.name && entry.bucket === desiredBucket)) {
        for (const filePath of candidate.allPaths ?? [candidate.filePath]) {
          if (path.resolve(filePath) === path.resolve(destination)) continue;
          if (await canonicalDigest(filePath, config.sync.stripEncryptedContent) === await canonicalDigest(destination, config.sync.stripEncryptedContent)) await fsp.rm(filePath, { force: true });
        }
      }
      archiveMoves += await moveOppositeCopies(candidates, home.name, home.path, desiredBucket, destination);
    }
  }
  await mergeSessionIndex(config);
  const archiveDatabaseUpdates = {};
  let archiveDatabaseConsistent = true;
  if (!archiveState.disabled) {
    const reconciledCandidates = await collectAllCandidates(config);
    for (const home of config.homes) archiveDatabaseUpdates[home.name] = await synchronizeArchiveDatabase(home, archiveState.archivedById, reconciledCandidates);
    archiveDatabaseConsistent = await archiveStatesMatchDatabases(config, archiveState.archivedById);
    if (archiveDatabaseConsistent) {
      const reconciledObservations = new Map();
      for (const home of config.homes) reconciledObservations.set(home.name, await readHomeArchiveStates(home, reconciledCandidates));
      await writeArchiveSnapshots(config, reconciledObservations);
    }
  }
  return { sessions: grouped.size, copiedToCanonical, copiedToHomes, conflicts, archiveMoves, archiveEventsWritten: archiveState.eventsWritten, archiveDatabaseUpdates, archiveDatabaseConsistent };
}

async function refreshProvider(config, home) {
  if (!config.providerSync?.enabled) return { skipped: true };
  const entry = path.resolve(repoRoot, config.providerSync.entry);
  const result = await run(process.execPath, [entry, "sync", "--json", "--codex-home", home.path], { cwd: repoRoot });
  if (result.code !== 0 && result.code !== 3) {
    await log(`provider refresh failed for ${home.name}: ${result.stderr || result.stdout}`);
    return { ok: false, code: result.code };
  }
  await log(`provider refresh ${home.name}: ${result.stdout.trim().slice(0, 1000)}`);
  return { ok: true, partial: result.code === 3 };
}

async function gitPull(config) {
  if (process.env.CODEX_HISTORY_SYNC_GIT_HOOK === "1" || !config.git.autoPull || hasFlag("--no-pull")) return;
  const check = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: dataRepoRoot });
  if (check.code !== 0) return;
  const fetch = await run("git", ["fetch", config.git.remote, config.git.branch], { cwd: dataRepoRoot });
  if (fetch.code !== 0) {
    await log(`git fetch deferred: ${fetch.stderr.trim()}`);
    return;
  }
  const rebase = await run("git", ["rebase", "--autostash", `${config.git.remote}/${config.git.branch}`], { cwd: dataRepoRoot });
  if (rebase.code !== 0) {
    await run("git", ["rebase", "--abort"], { cwd: dataRepoRoot });
    await log(`git rebase failed: ${rebase.stderr.trim()}`);
  }
}

async function gitCommitAndPush(config, summary) {
  if (hasFlag("--no-commit")) return;
  await run("git", ["add", "--", "data", "conflicts"], { cwd: dataRepoRoot });
  const diff = await run("git", ["diff", "--cached", "--quiet"], { cwd: dataRepoRoot });
  if (diff.code === 0) return;
  const message = `sync: merge Codex histories ${timestamp()}`;
  const commit = await run("git", ["commit", "-m", message], { cwd: dataRepoRoot });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  await log(`committed history sync: ${JSON.stringify(summary)}`);
  if (!config.git.autoPush || hasFlag("--no-push")) return;
  const push = await run("git", ["push", "-u", config.git.remote, config.git.branch], { cwd: dataRepoRoot });
  if (push.code !== 0) {
    await run("git", ["reset", "--soft", "HEAD~1"], { cwd: dataRepoRoot });
    await log(`git push failed; automatic commit was uncommitted for safety: ${push.stderr.trim()}`);
  }
}

async function spawnWorker(mode) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], {
    cwd: repoRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
}

async function main() {
  const config = await loadConfig();
  if (command === "enqueue") {
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(path.join(stateDir, "pending"), timestamp(), "utf8");
    await spawnWorker("drain");
    return;
  }
  if (command === "drain") {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, config.git.commitDebounceSeconds) * 1000));
  }
  const lock = await acquireLock(config.sync.lockStaleMinutes);
  if (!lock) {
    await log(`sync already running; command ${command} coalesced`);
    return;
  }
  try {
    if (command === "start" || command === "sync" || command === "pull" || command === "drain") await gitPull(config);
    await new Promise((resolve) => setTimeout(resolve, config.sync.settleMilliseconds));
    const summary = await synchronizeFiles(config);
    summary.indexRefresh = {};
    for (const home of config.homes) {
      const indexResult = await refreshThreadIndex(config, home);
      summary.indexRefresh[home.name] = indexResult;
      await log(`thread index refresh ${home.name}: ${JSON.stringify(indexResult)}`);
      await refreshProvider(config, home);
    }
    const uiMetadata = await collectUiMetadata(config, dataRepoRoot);
    summary.uiMetadata = { projects: uiMetadata.projects.length, names: Object.keys(uiMetadata.threadNames).length, homes: {} };
    for (const home of config.homes) {
      const result = await applyUiMetadata(config, home, uiMetadata);
      summary.uiMetadata.homes[home.name] = result;
      await log(`ui metadata sync ${home.name}: ${JSON.stringify(result)}`);
    }
    if (command !== "pull") await gitCommitAndPush(config, summary);
    await fsp.rm(path.join(stateDir, "pending"), { force: true });
    await log(`completed ${command}: ${JSON.stringify(summary)}`);
    console.log(JSON.stringify({ ok: true, command, summary }));
  } finally {
    await releaseLock(lock);
  }
}

main().catch(async (error) => {
  await log(`fatal ${command}: ${error.stack || error.message}`).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
