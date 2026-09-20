import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { collectUiMetadata, writeUiMetadataState, writeUiMetadataObservations, reconcileProjectLayout } from "../bin/ui-metadata.mjs";

function createStateDb(home, projects) {
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
    CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, project_id TEXT, archived INTEGER NOT NULL DEFAULT 0);
  `);
  const insertProject = db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)");
  const insertRoot = db.prepare("INSERT INTO project_roots VALUES (?, ?, ?)");
  const insertThread = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
  projects.forEach((project, position) => {
    insertProject.run(project.appId, project.name, position, 1, 1);
    project.roots.forEach((root, rootPosition) => insertRoot.run(project.appId, rootPosition, root));
    for (const threadId of project.threadIds ?? []) insertThread.run(threadId, null, project.appId, project.archivedThreadIds?.includes(threadId) ? 1 : 0);
  });
  db.close();
}

function globalState(home, projects) {
  const hostKey = `local:${home.replaceAll("/", "\\")}`;
  return {
    "electron-persisted-atom-state": {
      "codex-writing-block-deleted-thread-v1:thread-keep": true,
      "codex-writing-block-deleted-thread-v1:thread-removed": true
    },
    "local-projects": Object.fromEntries(projects.map((project) => [project.id, {
      id: project.id,
      name: project.name,
      rootPaths: project.roots,
      createdAt: 1,
      updatedAt: 1
    }])),
    "thread-project-assignments": Object.fromEntries(projects.flatMap((project) => (project.threadIds ?? []).map((threadId) => [threadId, { projectKind: "local", projectId: project.id }]))),
    "project-order": projects.map((project) => project.id),
    "sidebar-project-thread-orders": Object.fromEntries(projects.map((project) => [project.appId, { threadIds: [...(project.threadIds ?? [])] }])),
    "projectless-thread-ids": [],
    "app-server-project-id-by-legacy-project-id-by-host": {
      [hostKey]: Object.fromEntries(projects.map((project) => [project.id, project.appId]))
    },
    "app-server-projects-migration-by-host": {
      [hostKey]: { version: 1, projectsMigrated: true, threadAssignmentsMigrated: true, pendingThreadAssignmentIds: [] }
    }
  };
}

test("propagates a migrated Project deletion and removes stale sidebar state", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-project-delete-sync-"));
  try {
    const official = path.join(root, "official");
    const api = path.join(root, "api");
    const records = path.join(root, "records");
    await Promise.all([official, api, path.join(records, "data")].map((entry) => fsp.mkdir(entry, { recursive: true })));

    const keep = { id: "legacy-keep", appId: "app-official-keep", name: "Keep", roots: ["C:\\Work\\Keep"], threadIds: ["thread-keep", "thread-keep-archived"], archivedThreadIds: ["thread-keep-archived"] };
    const removed = { id: "legacy-removed", appId: "app-official-removed", name: "Removed", roots: ["C:\\Work\\Removed"], threadIds: ["thread-removed"] };
    createStateDb(official, [keep]);
    createStateDb(api, [
      { ...keep, appId: "app-api-keep" },
      { ...removed, appId: "app-api-removed" }
    ]);
    await fsp.writeFile(path.join(official, ".codex-global-state.json"), JSON.stringify(globalState(official, [keep, removed])));
    await fsp.writeFile(path.join(api, ".codex-global-state.json"), JSON.stringify(globalState(api, [
      { ...keep, appId: "app-api-keep" },
      { ...removed, appId: "app-api-removed" }
    ])));
    await fsp.writeFile(path.join(records, "data", "ui-metadata.json"), JSON.stringify({
      schemaVersion: 1,
      projects: [keep, removed].map((project) => ({ ...project, roots: project.roots, threadIds: project.threadIds, createdAt: 1, updatedAt: 1 })),
      threadNames: {}
    }));

    const config = {
      homes: [{ name: "official", path: official }, { name: "api", path: api }],
      sync: { includeUiMetadata: true, propagateDeletes: true }
    };
    const metadata = await collectUiMetadata(config, records);
    assert.deepEqual(metadata.projects.map((project) => project.id), [keep.id]);
    const eventFiles = [];
    const pending = [path.join(records, "data", "project-events")];
    while (pending.length) {
      const current = pending.pop();
      if (!fs.existsSync(current)) continue;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else eventFiles.push(full);
      }
    }
    assert.equal(eventFiles.length, 1);
    assert.equal(JSON.parse(await fsp.readFile(eventFiles[0], "utf8")).deleted, true);

    await writeUiMetadataState(config, { name: "api", path: api }, metadata);
    const state = JSON.parse(await fsp.readFile(path.join(api, ".codex-global-state.json"), "utf8"));
    assert.deepEqual(Object.keys(state["local-projects"]), [keep.id]);
    assert.equal(state["thread-project-assignments"]["thread-removed"], undefined);
    assert.equal(state["thread-project-assignments"]["thread-keep-archived"], undefined);
    assert.equal(state["thread-project-assignments"]["thread-keep"].projectId, keep.id);
    assert.equal(state["electron-persisted-atom-state"]["codex-writing-block-deleted-thread-v1:thread-keep"], undefined);
    assert.equal(state["electron-persisted-atom-state"]["codex-writing-block-deleted-thread-v1:thread-keep-archived"], undefined);
    assert.equal(state["electron-persisted-atom-state"]["codex-writing-block-deleted-thread-v1:thread-removed"], undefined);
    assert.deepEqual(state["sidebar-project-thread-orders"]["app-api-keep"].threadIds, ["thread-keep"]);
    assert.deepEqual(state["project-order"], [keep.id]);
    const hostKey = `local:${api.replaceAll("/", "\\")}`;
    assert.deepEqual(state["app-server-project-id-by-legacy-project-id-by-host"][hostKey], { [keep.id]: "app-api-keep" });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("synchronizes project order, rename, moves and projectless removals instead of unioning stale assignments", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-project-layout-"));
  try {
    const a = path.join(root, "a"), b = path.join(root, "b"), records = path.join(root, "records");
    await Promise.all([a, b, records].map((p) => fsp.mkdir(p)));
    const projects = [
      { id: "one", appId: "a-one", name: "One", roots: ["C:/one"], threadIds: ["move", "remove", "archive"], archivedThreadIds: ["archive"] },
      { id: "two", appId: "a-two", name: "Two", roots: ["C:/two"], threadIds: [] }
    ];
    const bProjects = projects.map((p) => ({ ...p, appId: p.appId.replace("a-", "b-") })).reverse();
    createStateDb(a, projects); createStateDb(b, bProjects);
    await fsp.writeFile(path.join(a, ".codex-global-state.json"), JSON.stringify(globalState(a, projects)));
    await fsp.writeFile(path.join(b, ".codex-global-state.json"), JSON.stringify(globalState(b, bProjects)));
    const config = { homes: [{ name: "a", path: a }, { name: "b", path: b }], sync: { includeUiMetadata: true, propagateDeletes: true } };
    const metadata = await collectUiMetadata(config, records);
    assert.deepEqual(metadata.projects.map((p) => p.name), ["One", "Two"]);
    await reconcileProjectLayout(config.homes[1], metadata);
    await writeUiMetadataObservations(config, records, metadata);
    const db = new DatabaseSync(path.join(b, "state_5.sqlite"));
    db.exec("UPDATE projects SET position=1 WHERE id='b-one'; UPDATE projects SET position=0,name='Renamed' WHERE id='b-two'; UPDATE threads SET project_id='b-two' WHERE id='move'; UPDATE threads SET project_id=NULL WHERE id='remove'");
    db.close();
    const changed = await collectUiMetadata(config, records);
    assert.deepEqual(changed.projects.map((p) => p.name), ["Renamed", "One"]);
    assert.deepEqual(changed.projects[0].threadIds, ["move"]);
    assert.deepEqual(changed.projects[1].threadIds, ["archive"]);
    assert.deepEqual(changed.projectlessThreadIds, ["remove"]);
    await reconcileProjectLayout(config.homes[0], changed);
    await writeUiMetadataState(config, config.homes[0], changed);
    const verify = new DatabaseSync(path.join(a, "state_5.sqlite"), { readOnly: true });
    assert.equal(verify.prepare("SELECT project_id FROM threads WHERE id='remove'").get().project_id, null);
    assert.deepEqual(verify.prepare("SELECT name FROM projects ORDER BY position").all().map((p) => p.name), ["Renamed", "One"]);
    verify.close();
    const state = JSON.parse(await fsp.readFile(path.join(a, ".codex-global-state.json")));
    assert.deepEqual(state["project-order"], ["two", "one"]);
    assert.equal(state["thread-project-assignments"].move.projectId, "two");
    assert.equal(state["thread-project-assignments"].remove, undefined);
    assert.equal(state["thread-project-assignments"].archive, undefined);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
