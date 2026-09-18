import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rolloutFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entry.name);
    }
  }
  return files.sort();
}

test("preserves every physical rollout in a paginated thread lineage", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-lineage-sync-"));
  try {
    const framework = path.join(root, "framework");
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    const records = path.join(root, "records");
    await fsp.mkdir(framework, { recursive: true });
    await fsp.cp(path.join(repoRoot, "bin"), path.join(framework, "bin"), { recursive: true });
    await Promise.all([homeA, homeB, records].map((entry) => fsp.mkdir(entry, { recursive: true })));
    await Promise.all([
      fsp.writeFile(path.join(homeA, "config.toml"), 'model_provider = "openai"\n'),
      fsp.writeFile(path.join(homeB, "config.toml"), 'model_provider = "tencent"\n')
    ]);

    const threadId = "11111111-1111-7111-8111-111111111111";
    const childRolloutId = "22222222-2222-7222-8222-222222222222";
    const sourceName = `rollout-2026-01-01T00-00-00-${threadId}.jsonl`;
    const childName = `rollout-2026-01-02T00-00-00-${threadId}_${childRolloutId}.jsonl`;
    const sourceRoot = path.join(homeA, "sessions", "2026", "01", "01");
    await fsp.mkdir(sourceRoot, { recursive: true });
    const source = `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: { id: threadId, session_id: threadId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:/fixture", source: "exec", model_provider: "openai", history_mode: "paginated" }
    })}\n${JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started" } })}\n`;
    const sourcePath = path.join(sourceRoot, sourceName);
    const childRoot = path.join(homeA, "sessions", "2026", "01", "02");
    const childPath = path.join(childRoot, childName);
    await fsp.mkdir(childRoot, { recursive: true });
    await fsp.writeFile(sourcePath, source);
    const sourceRootB = path.join(homeB, "sessions", "2026", "01", "01");
    const sourcePathB = path.join(sourceRootB, sourceName);
    await fsp.mkdir(sourceRootB, { recursive: true });
    await fsp.writeFile(sourcePathB, source
      .replace('"model_provider":"openai"', '"model_provider":"tencent"')
      .replace("\n{", "\n \n\t\n{"));
    const childMeta = {
      timestamp: "2026-01-02T00:00:00.000Z",
      ordinal: 2,
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        timestamp: "2026-01-02T00:00:00.000Z",
        cwd: "C:/fixture",
        source: "exec",
        model_provider: "openai",
        history_mode: "paginated",
        history_base: { thread_id: threadId, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(source) }
      }
    };
    const childMetaLine = JSON.stringify(childMeta);
    const appendedEvent = JSON.stringify({ timestamp: "2026-01-02T00:00:01.000Z", ordinal: 3, type: "event_msg", payload: { type: "task_started" } });
    await fsp.writeFile(childPath, `${childMetaLine}\n${appendedEvent}\n`);
    const childRootB = path.join(homeB, "sessions", "2026", "01", "02");
    const childPathB = path.join(childRootB, childName);
    await fsp.mkdir(childRootB, { recursive: true });
    await fsp.writeFile(childPathB, `${childMetaLine.replace('"model_provider":"openai"', '"model_provider":"tencent"')}\n`);
    const settled = new Date(Date.now() - 10 * 60_000);
    await Promise.all([sourcePath, sourcePathB, childPath, childPathB].map((entry) => fsp.utimes(entry, settled, settled)));

    await fsp.writeFile(path.join(framework, "sync.config.json"), JSON.stringify({
      schemaVersion: 1,
      homes: [{ name: "a", path: homeA }, { name: "b", path: homeB }],
      git: { dataRepository: records, remote: "origin", branch: "main", autoPull: false, autoPush: false, commitDebounceSeconds: 1 },
      providerSync: { enabled: false },
      sync: { includeArchived: true, includeSessionIndex: false, refreshThreadIndex: false, includeUiMetadata: false, stripEncryptedContent: true, settleMilliseconds: 1, lockStaleMinutes: 30 }
    }, null, 2));

    const result = spawnSync(process.execPath, [path.join(framework, "bin", "sync-history.mjs"), "sync", "--no-pull", "--no-push", "--no-commit"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const sessionRoot of [path.join(homeA, "sessions"), path.join(homeB, "sessions"), path.join(records, "data", "sessions")]) {
      assert.deepEqual(rolloutFiles(sessionRoot), [sourceName, childName].sort());
    }
    const summary = JSON.parse(result.stdout).summary;
    assert.equal(summary.sessions, 1);
    assert.equal(summary.rollouts, 2);
    assert.equal(summary.conflicts, 0);
    assert.equal(fs.existsSync(path.join(records, "conflicts", threadId)), false);
    assert.match(await fsp.readFile(childPathB, "utf8"), /"task_started"/);

    const writerLockRoot = path.join(homeA, "thread-writer-locks");
    await fsp.mkdir(writerLockRoot, { recursive: true });
    await fsp.writeFile(path.join(writerLockRoot, `${threadId}.lock`), "");
    const canonicalSource = path.join(records, "data", "sessions", "2026", "01", "01", sourceName);
    const staleCanonicalEvent = JSON.stringify({ timestamp: "2026-01-01T00:00:01.500Z", ordinal: 2, type: "event_msg", payload: { type: "thread_settings_applied" } });
    await fsp.writeFile(canonicalSource, `${source}${staleCanonicalEvent}\n`);
    const liveEvent = JSON.stringify({ timestamp: new Date().toISOString(), ordinal: 4, type: "event_msg", payload: { type: "user_message", message: "live snapshot" } });
    await fsp.appendFile(sourcePath, `${liveEvent}\n`);
    const liveResult = spawnSync(process.execPath, [path.join(framework, "bin", "sync-history.mjs"), "sync", "--no-pull", "--no-push", "--no-commit"], { encoding: "utf8" });
    assert.equal(liveResult.status, 0, `${liveResult.stdout}\n${liveResult.stderr}`);
    assert.match(await fsp.readFile(sourcePathB, "utf8"), /live snapshot/);
    assert.match(await fsp.readFile(canonicalSource, "utf8"), /live snapshot/);
    assert.equal(fs.existsSync(path.join(records, "conflicts", threadId)), false);
    assert.ok(JSON.parse(liveResult.stdout).summary.activeSnapshotRollouts >= 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("rebases a stale descendant onto the latest source without losing descendant-only turns", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-lineage-rebase-"));
  try {
    const framework = path.join(root, "framework");
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    const records = path.join(root, "records");
    await fsp.mkdir(framework, { recursive: true });
    await fsp.cp(path.join(repoRoot, "bin"), path.join(framework, "bin"), { recursive: true });
    await Promise.all([homeA, homeB, records].map((entry) => fsp.mkdir(entry, { recursive: true })));
    await fsp.writeFile(path.join(homeA, "config.toml"), 'model_provider = "openai"\n');
    await fsp.writeFile(path.join(homeB, "config.toml"), 'model_provider = "tencent"\n');

    const threadId = "33333333-3333-7333-8333-333333333333";
    const childRolloutId = "44444444-4444-7444-8444-444444444444";
    const sourceName = `rollout-2026-02-01T00-00-00-${threadId}.jsonl`;
    const childName = `rollout-2026-02-02T00-00-00-${threadId}_${childRolloutId}.jsonl`;
    const sourcePath = path.join(homeA, "sessions", "2026", "02", "01", sourceName);
    const childPath = path.join(homeB, "sessions", "2026", "02", "02", childName);
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.mkdir(path.dirname(childPath), { recursive: true });
    for (const [home, initialPath] of [[homeA, sourcePath], [homeB, sourcePath]]) {
      const stateDb = new DatabaseSync(path.join(home, "state_5.sqlite"));
      stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, rollout_path TEXT NOT NULL)");
      stateDb.prepare("INSERT INTO threads (id, archived, rollout_path) VALUES (?, 0, ?)").run(threadId, initialPath);
      stateDb.close();
      const historyDb = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
      for (const table of ["thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state"]) historyDb.exec(`CREATE TABLE ${table} (thread_id TEXT)`);
      historyDb.prepare("INSERT INTO thread_items (thread_id) VALUES (?)").run(threadId);
      historyDb.close();
    }
    const sourceRecords = [
      { timestamp: "2026-02-01T00:00:00Z", ordinal: 0, type: "session_meta", payload: { id: threadId, session_id: threadId, timestamp: "2026-02-01T00:00:00Z", cwd: "C:/fixture", source: "exec", model_provider: "openai", history_mode: "paginated" } },
      { timestamp: "2026-02-01T00:00:01Z", ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "turn-base-old" } },
      { timestamp: "2026-02-01T00:00:02Z", ordinal: 2, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-base-old" } },
      { timestamp: "2026-02-03T00:00:01Z", ordinal: 3, type: "event_msg", payload: { type: "task_started", turn_id: "turn-base-new" } },
      { timestamp: "2026-02-03T00:00:02Z", ordinal: 4, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-base-new" } }
    ];
    const frozenPrefix = sourceRecords.slice(0, 3).map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await fsp.writeFile(sourcePath, sourceRecords.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    const childRecords = [
      { timestamp: "2026-02-02T00:00:00Z", ordinal: 3, type: "session_meta", payload: { id: threadId, session_id: threadId, timestamp: "2026-02-02T00:00:00Z", cwd: "C:/fixture", source: "exec", model_provider: "tencent", history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(frozenPrefix) } } },
      { timestamp: "2026-02-02T00:00:01Z", ordinal: 4, type: "event_msg", payload: { type: "task_started", turn_id: "turn-child-only" } },
      { timestamp: "2026-02-02T00:00:02Z", ordinal: 5, type: "response_item", payload: { type: "message", id: "msg-child", role: "user", content: [{ type: "input_text", text: "child work" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-child-only" } } },
      { timestamp: "2026-02-02T00:00:03Z", ordinal: 6, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-child-only" } }
    ];
    await fsp.writeFile(childPath, childRecords.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    const settled = new Date(Date.now() - 10 * 60_000);
    await Promise.all([sourcePath, childPath].map((entry) => fsp.utimes(entry, settled, settled)));
    await fsp.writeFile(path.join(framework, "sync.config.json"), JSON.stringify({
      schemaVersion: 1,
      homes: [{ name: "a", path: homeA }, { name: "b", path: homeB }],
      git: { dataRepository: records, remote: "origin", branch: "main", autoPull: false, autoPush: false, commitDebounceSeconds: 1 },
      providerSync: { enabled: false },
      sync: { includeArchived: true, includeSessionIndex: false, refreshThreadIndex: false, includeUiMetadata: false, stripEncryptedContent: true, settleMilliseconds: 1, lockStaleMinutes: 30 }
    }, null, 2));

    const result = spawnSync(process.execPath, [path.join(framework, "bin", "sync-history.mjs"), "sync", "--no-pull", "--no-push", "--no-commit"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout).summary;
    assert.ok(summary.rebasedLineages >= 1);
    const rebased = (await fsp.readFile(childPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rebased[0].payload.history_base, undefined);
    assert.equal(rebased[0].payload.history_mode, "legacy");
    assert.deepEqual(rebased.map((entry) => entry.ordinal), rebased.map((_, index) => index));
    const serialized = JSON.stringify(rebased);
    assert.match(serialized, /turn-base-new/);
    assert.match(serialized, /turn-child-only/);
    assert.equal(rebased[0].payload.sync_lineage_base.merged_source_ordinal, 4);
    for (const home of [homeA, homeB]) {
      const db = new DatabaseSync(path.join(home, "state_5.sqlite"), { readOnly: true });
      assert.equal(path.basename(db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId).rollout_path), childName);
      db.close();
      const historyDb = new DatabaseSync(path.join(home, "thread_history_1.sqlite"), { readOnly: true });
      assert.equal(historyDb.prepare("SELECT count(*) AS count FROM thread_items WHERE thread_id = ?").get(threadId).count, 0);
      historyDb.close();
    }

    // Older framework versions flattened the lineage but left the rollout in
    // paginated mode. Migrate those files even when the source has not grown.
    rebased[0].payload.history_mode = "paginated";
    const legacyMigrationPaths = [
      path.join(homeA, "sessions", "2026", "02", "02", childName),
      childPath,
      path.join(records, "data", "sessions", "2026", "02", "02", childName)
    ];
    for (const [variantIndex, rolloutPath] of legacyMigrationPaths.entries()) {
      const variant = structuredClone(rebased);
      if (variantIndex < 2) {
        variant.push({ timestamp: `2026-02-03T00:00:0${5 + variantIndex}Z`, ordinal: variant.length, type: "event_msg", payload: { type: "task_complete", turn_id: `turn-migration-${variantIndex}` } });
      }
      await fsp.writeFile(rolloutPath, variant.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      await fsp.utimes(rolloutPath, settled, settled);
    }
    const migrationResult = spawnSync(process.execPath, [path.join(framework, "bin", "sync-history.mjs"), "sync", "--no-pull", "--no-push", "--no-commit"], { encoding: "utf8" });
    assert.equal(migrationResult.status, 0, `${migrationResult.stdout}\n${migrationResult.stderr}`);
    const migrated = (await fsp.readFile(childPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(migrated[0].payload.history_mode, "legacy");
    assert.match(JSON.stringify(migrated), /turn-child-only/);
    assert.match(JSON.stringify(migrated), /turn-migration-0/);
    assert.match(JSON.stringify(migrated), /turn-migration-1/);

    const laterSourceRecord = { timestamp: "2026-02-04T00:00:00Z", ordinal: 5, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-source-later" } };
    await fsp.appendFile(sourcePath, `${JSON.stringify(laterSourceRecord)}\n`);
    const secondResult = spawnSync(process.execPath, [path.join(framework, "bin", "sync-history.mjs"), "sync", "--no-pull", "--no-push", "--no-commit"], { encoding: "utf8" });
    assert.equal(secondResult.status, 0, `${secondResult.stdout}\n${secondResult.stderr}`);
    const rebasedAgain = (await fsp.readFile(childPath, "utf8")).trim().split("\n").map(JSON.parse);
    const serializedAgain = JSON.stringify(rebasedAgain);
    assert.match(serializedAgain, /turn-child-only/);
    assert.match(serializedAgain, /turn-source-later/);
    assert.equal(rebasedAgain[0].payload.sync_lineage_base.merged_source_ordinal, 5);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
