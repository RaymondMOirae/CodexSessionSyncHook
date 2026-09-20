import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { readHomeRuntime } from "./runtime-state.mjs";

// Desktop's sidebar is persisted separately from Core's state_5.sqlite.
// Only reconcile a stopped Home; a live Electron process owns its cache.
export async function reconcileDesktopCatalog(home, { runtime, deletedThreadIds = [] } = {}) {
  const status = runtime ?? await readHomeRuntime(home);
  if (!status.known || status.running) return { skipped: true, reason: status.running ? "desktop-running" : "runtime-unknown" };
  const corePath = [path.join(home.path, "state_5.sqlite"), path.join(home.path, "sqlite", "state_5.sqlite")].find(fs.existsSync);
  if (!corePath) return { skipped: true, reason: "state-db-missing" };
  const core = new DatabaseSync(corePath, { readOnly: true });
  let threads;
  try { threads = core.prepare("SELECT id, archived, name, project_id, updated_at FROM threads ORDER BY id").all(); }
  finally { core.close(); }
  const byId = new Map(threads.map((row) => [row.id, row]));
  const deleted = new Set(deletedThreadIds);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ threads, deleted: [...deleted].sort() })).digest("hex");
  const results = [];
  for (const filename of ["codex.db", "codex-dev.db"]) {
    const dbPath = path.join(home.path, "sqlite", filename);
    if (!fs.existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      if (!["local_thread_catalog", "local_thread_catalog_sync_state", "local_thread_catalog_metadata"].every((table) => tables.has(table))) {
        results.push({ file: filename, skipped: true, reason: "catalog-schema-unavailable" }); continue;
      }
      const columns = new Set(db.prepare("PRAGMA table_info(local_thread_catalog)").all().map((row) => row.name));
      if (!["host_id", "thread_id", "project_id", "display_title"].every((column) => columns.has(column))) {
        results.push({ file: filename, skipped: true, reason: "catalog-schema-unsupported" }); continue;
      }
      const rows = db.prepare("SELECT * FROM local_thread_catalog WHERE host_id = 'local'").all();
      const removed = rows.filter((row) => byId.get(row.thread_id)?.archived || deleted.has(row.thread_id));
      const changed = rows.filter((row) => {
        const source = byId.get(row.thread_id);
        return source && !source.archived && !deleted.has(source.id) &&
          (row.project_id !== source.project_id || (source.name && row.display_title !== source.name));
      });
      const markerPath = path.join(home.path, "cache", `history-sync-${filename}.json`);
      let marker; try { marker = JSON.parse(await fsp.readFile(markerPath, "utf8")); } catch {}
      const needsScan = marker?.fingerprint !== fingerprint || removed.length > 0 || changed.length > 0;
      if (!needsScan) { results.push({ file: filename, removed: 0, updated: 0, scanInvalidated: false }); continue; }
      const backupDir = path.join(home.path, "backups_state", "desktop-catalog", `${Date.now()}-${process.pid}`);
      await fsp.mkdir(backupDir, { recursive: true });
      await backup(db, path.join(backupDir, filename));
      // Do not delete the entire desktop DB: it also holds automations and
      // remote/cloud catalogs. Invalidate only the local incremental scan.
      db.exec("BEGIN IMMEDIATE");
      try {
        const remove = db.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
        for (const row of removed) remove.run(row.thread_id);
        const update = db.prepare("UPDATE local_thread_catalog SET project_id = ?, display_title = ? WHERE host_id = 'local' AND thread_id = ?");
        for (const row of changed) {
          const source = byId.get(row.thread_id);
          update.run(source.project_id, source.name || row.display_title, row.thread_id);
        }
        const syncColumns = new Set(db.prepare("PRAGMA table_info(local_thread_catalog_sync_state)").all().map((row) => row.name));
        const reset = ["watermark_updated_at = NULL", "initial_build_complete = 0"];
        if (syncColumns.has("last_full_reconciled_at")) reset.push("last_full_reconciled_at = NULL");
        db.exec(`UPDATE local_thread_catalog_sync_state SET ${reset.join(", ")} WHERE host_id = 'local'`);
        for (const table of ["local_thread_catalog_scan_checkpoints", "local_thread_catalog_scan_entries"]) {
          if (tables.has(table)) db.exec(`DELETE FROM ${table} WHERE host_id = 'local'`);
        }
        db.exec("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      await fsp.mkdir(path.dirname(markerPath), { recursive: true });
      await fsp.writeFile(markerPath, JSON.stringify({ fingerprint }));
      results.push({ file: filename, removed: removed.length, updated: changed.length, scanInvalidated: true, backupDir });
    } finally { db.close(); }
  }
  return { ok: true, results };
}
