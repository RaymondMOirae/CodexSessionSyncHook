import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
