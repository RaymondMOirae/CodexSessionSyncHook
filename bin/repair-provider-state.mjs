#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { readToolConfig } from "./config.mjs";
import { readHomeRuntime } from "./runtime-state.mjs";
import { ProviderStateStore, isThreadWriterLocked } from "./provider-state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ids = args.filter((value, index) => args[index - 1] === "--thread");
const homeName = args[args.indexOf("--home") + 1];
const apply = args.includes("--apply");
if (!ids.length || !args.includes("--home") || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
  throw new Error("Usage: node bin/repair-provider-state.mjs --home NAME --thread UUID [--thread UUID] [--from-git] [--apply]");
}
const { config } = await readToolConfig(root);
const home = config.homes.find((entry) => entry.name === homeName);
if (!home) throw new Error("Unknown Home");
const repo = config.git.dataRepository;
let syncLock;
if (apply) {
  await fs.mkdir(path.join(repo, ".sync"), { recursive: true });
  syncLock = await fs.open(path.join(repo, ".sync", "sync.lock"), "wx");
  await syncLock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), operation: "provider-state-repair" }));
}
try {
const store = new ProviderStateStore(repo);
const git = (...command) => execFileSync("git", command, { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).trim();
let captured = 0, missingObjects = 0;
if (args.includes("--from-git")) {
  const files = git("ls-files", "data/sessions", "data/archived_sessions").split("\n").filter((file) => ids.some((id) => file.includes(id)));
  const objects = new Set();
  for (const file of files) for (const commit of git("log", "--all", "--format=%H", "--", file).split("\n").filter(Boolean)) {
    let pointer;
    try { pointer = git("show", `${commit}:${file}`); } catch { continue; }
    const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(pointer)?.[1];
    if (!oid || objects.has(oid)) continue;
    objects.add(oid);
    const object = path.join(repo, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    let bytes;
    try { bytes = await fs.readFile(object); } catch (error) { if (error.code !== "ENOENT") throw error; missingObjects++; continue; }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== oid) throw new Error("LFS object checksum mismatch");
    const records = bytes.toString("utf8").trim().split(/\r?\n/).map(JSON.parse);
    const meta = records[0]?.payload;
    if (ids.includes(meta?.id) && meta.model_provider) captured += await store.capture(meta.id, meta.model_provider, records);
  }
}
if (apply) await store.save();
const runtime = await readHomeRuntime(home);
const canApply = runtime.known && !runtime.running;
const reports = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(home.path, "backups_state", "provider-state-repair", stamp);
const pending = [path.join(home.path, "sessions"), path.join(home.path, "archived_sessions")];
const changedThreads = new Set();
while (pending.length) {
  const directory = pending.pop();
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; continue; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { pending.push(file); continue; }
    if (!entry.name.endsWith(".jsonl") || !ids.some((id) => entry.name.includes(id))) continue;
    const original = await fs.readFile(file, "utf8");
    const records = original.trimEnd().split(/\r?\n/).map(JSON.parse);
    const meta = records[0]?.payload;
    if (!ids.includes(meta?.id) || !meta.model_provider) continue;
    const restore = await store.restorer(meta.id, meta.model_provider);
    let restored = 0;
    for (const record of records) restored += restore(record);
    let missingCompactions = 0;
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "compaction" && !value.encrypted_content) missingCompactions++;
      for (const child of Object.values(value)) inspect(child);
    };
    for (const record of records) inspect(record);
    reports.push({ file, threadId: meta.id, provider: meta.model_provider, restored, missingCompactions, applied: Boolean(apply && canApply && restored) });
    if (!apply || !canApply || !restored) continue;
    // Re-check process state immediately before changing a stopped Home.
    const current = await readHomeRuntime(home);
    if (!current.known || current.running) throw new Error("Home started during repair; remaining changes deferred");
    if (await isThreadWriterLocked(home.path, meta.id)) throw new Error("Thread writer is still locked; repair deferred");
    if (await fs.readFile(file, "utf8") !== original) throw new Error("Rollout changed during repair");
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.copyFile(file, path.join(backupRoot, entry.name));
    await fs.writeFile(`${file}.provider-repair.tmp`, records.map(JSON.stringify).join("\n") + "\n", "utf8");
    await fs.rename(`${file}.provider-repair.tmp`, file);
    changedThreads.add(meta.id);
  }
}
if (changedThreads.size) {
  const dbPath = path.join(home.path, "thread_history_1.sqlite");
  try {
    await fs.access(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      await backup(db, path.join(backupRoot, "thread_history_1.sqlite"));
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of ["thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state"]) {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
          for (const id of changedThreads) db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(id);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
console.log(JSON.stringify({ ok: true, mode: apply ? "apply" : "audit", captured, missingObjects, deferred: apply && !canApply, reason: !canApply ? "Home is running or its runtime could not be verified" : null, backupRoot: changedThreads.size ? backupRoot : null, reports }));
if (apply && !canApply) process.exitCode = 2;
} finally {
  if (syncLock) {
    await syncLock.close();
    await fs.rm(path.join(repo, ".sync", "sync.lock"), { force: true });
  }
}
