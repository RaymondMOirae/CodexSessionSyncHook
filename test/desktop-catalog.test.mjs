import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { reconcileDesktopCatalog } from "../bin/desktop-catalog.mjs";
import { matchHomeProcesses } from "../bin/runtime-state.mjs";

test("tracks mirrored backend and desktop across bridge exit/backend restart without matching another Home", () => {
  const home = { path: "C:/fixture/api", clientExecutable: "C:/Apps/Bridge.exe", uiStateExitProcessPaths: ["C:/Apps/shim.exe"] };
  const desktop = { ProcessId: 10, ParentProcessId: 9, CreationDate: "start", Name: "ChatGPT.exe", ExecutablePath: "C:/Apps/ChatGPT.exe", CommandLine: "ChatGPT.exe" };
  const backend = { ProcessId: 11, ParentProcessId: 10, CreationDate: "backend", Name: "codex.exe", ExecutablePath: "C:/fixture/api/runtime/codex-mirror/codex.exe", CommandLine: "codex.exe app-server" };
  const unrelated = { ...backend, ProcessId: 12, ExecutablePath: "C:/fixture/api/runtime/codex-mirror-other/codex.exe" };
  const state = matchHomeProcesses(home, [desktop, backend, unrelated]);
  assert.equal(state.backendCount, 1);
  assert.equal(state.desktopCount, 1);
  assert.equal(matchHomeProcesses(home, [desktop], state.trackedDesktops).running, true);
  assert.equal(matchHomeProcesses(home, [], state.trackedDesktops).running, false);
  assert.equal(matchHomeProcesses(home, [{ ...desktop, CreationDate: "reused-pid" }], state.trackedDesktops).running, false);
  assert.equal(matchHomeProcesses(home, [unrelated]).running, false);
});

async function fixture(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "desktop-catalog-sync-"));
  try {
    await fsp.mkdir(path.join(root, "sqlite"));
    const core = new DatabaseSync(path.join(root, "state_5.sqlite"));
    core.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, name TEXT, project_id TEXT, updated_at INTEGER);
      INSERT INTO threads VALUES ('archived',1,'Archived','project-b',1),('active',0,'New title','project-b',1),('new-old',0,'Imported old chat',NULL,1),('new-archived',1,'Created then archived','project-b',1);`);
    core.close();
    const catalogPath = path.join(root, "sqlite", "codex-dev.db");
    const db = new DatabaseSync(catalogPath);
    db.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, project_id TEXT, missing_candidate INTEGER DEFAULT 0, PRIMARY KEY(host_id,thread_id));
      INSERT INTO local_thread_catalog VALUES ('local','archived','Archived',NULL,0),('local','active','Old title','project-a',0),('local','deleted','Deleted',NULL,0),('remote','archived','Remote unaffected',NULL,0);
      CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, watermark_updated_at REAL, initial_build_complete INTEGER, observation_sequence INTEGER, last_full_reconciled_at INTEGER);
      INSERT INTO local_thread_catalog_sync_state VALUES ('local',99999,1,20,99999),('remote',99999,1,5,99999);
      CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT, checkpoint TEXT);
      INSERT INTO local_thread_catalog_scan_checkpoints VALUES ('local','stale-page'),('remote','keep');
      CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER);
      INSERT INTO local_thread_catalog_scan_entries VALUES ('local','archived',0),('remote','archived',0);
      CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER);
      INSERT INTO local_thread_catalog_metadata VALUES (1,5);
      CREATE TABLE automations (id TEXT, prompt TEXT);
      INSERT INTO automations VALUES ('keep','Do not touch');`);
    db.close();
    await fn({ home: { path: root }, catalogPath });
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}

test("repairs actual sidebar cache, invalidates high watermarks, preserves archives/cloud/automations, is idempotent", async () => fixture(async ({ home, catalogPath }) => {
  const result = await reconcileDesktopCatalog(home, { runtime: { known: true, running: false }, deletedThreadIds: ["deleted"] });
  assert.equal(result.results[0].removed, 2);
  assert.equal(result.results[0].updated, 1);
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM local_thread_catalog WHERE host_id='local'").get().n, 1);
  assert.deepEqual({ ...db.prepare("SELECT display_title,project_id FROM local_thread_catalog WHERE host_id='local'").get() }, { display_title: "New title", project_id: "project-b" });
  const state = db.prepare("SELECT * FROM local_thread_catalog_sync_state WHERE host_id='local'").get();
  assert.equal(state.watermark_updated_at, null);
  assert.equal(state.initial_build_complete, 0);
  assert.equal(state.last_full_reconciled_at, null);
  assert.equal(state.observation_sequence, 20);
  assert.equal(db.prepare("SELECT count(*) n FROM local_thread_catalog_scan_checkpoints WHERE host_id='local'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM local_thread_catalog_scan_entries WHERE host_id='local'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM local_thread_catalog WHERE host_id='remote'").get().n, 1);
  assert.equal(db.prepare("SELECT watermark_updated_at n FROM local_thread_catalog_sync_state WHERE host_id='remote'").get().n, 99999);
  assert.equal(db.prepare("SELECT count(*) n FROM automations").get().n, 1);
  db.close();
  const backupDb = new DatabaseSync(path.join(result.results[0].backupDir, "codex-dev.db"), { readOnly: true });
  assert.equal(backupDb.prepare("SELECT count(*) n FROM local_thread_catalog").get().n, 4); backupDb.close();
  const core = new DatabaseSync(path.join(home.path, "state_5.sqlite"), { readOnly: true });
  assert.equal(core.prepare("SELECT count(*) n FROM threads WHERE archived=1").get().n, 2); core.close();
  const again = await reconcileDesktopCatalog(home, { runtime: { known: true, running: false }, deletedThreadIds: ["deleted"] });
  assert.equal(again.results[0].scanInvalidated, false);
}));

test("does not rewrite a running or unknown desktop cache", async () => fixture(async ({ home, catalogPath }) => {
  for (const runtime of [{ known: true, running: true }, { known: false }]) {
    assert.equal((await reconcileDesktopCatalog(home, { runtime })).skipped, true);
  }
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM local_thread_catalog").get().n, 4); db.close();
}));
