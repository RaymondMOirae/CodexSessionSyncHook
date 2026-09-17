import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

function normalizeRoot(value) {
  let root = String(value ?? "").replace(/^\\\\\?\\/, "");
  if (/^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\")) {
    return path.win32.normalize(root).toLowerCase();
  }
  root = root.replaceAll("\\", "/");
  return path.posix.normalize(root);
}

function rootsKey(roots) {
  return [...roots].map(normalizeRoot).filter(Boolean).sort().join("|");
}

async function exists(filePath) {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

function stateDbPath(homePath) {
  const root = path.join(homePath, "state_5.sqlite");
  const nested = path.join(homePath, "sqlite", "state_5.sqlite");
  if (fs.existsSync(root)) return root;
  if (fs.existsSync(nested)) return nested;
  return null;
}

function readSessionNames(filePath, names) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id !== "string" || typeof entry.thread_name !== "string" || !entry.thread_name.trim()) continue;
      const updatedAt = Date.parse(entry.updated_at ?? "") || 0;
      const current = names.get(entry.id);
      if (!current || updatedAt >= current.updatedAt) names.set(entry.id, { name: entry.thread_name, updatedAt });
    } catch {}
  }
}

function addProject(projects, source) {
  const roots = Array.isArray(source.roots) ? source.roots.map(String).filter(Boolean) : [];
  const key = rootsKey(roots) || `id:${source.id}`;
  let project = projects.get(key);
  if (!project) {
    project = {
      id: source.id,
      name: source.name || path.basename(roots[0] || "Project"),
      roots: new Set(roots),
      threadIds: new Set(),
      createdAt: source.createdAt || Date.now(),
      updatedAt: source.updatedAt || Date.now()
    };
    projects.set(key, project);
  } else {
    for (const root of roots) project.roots.add(root);
    project.updatedAt = Math.max(project.updatedAt, source.updatedAt || 0);
  }
  for (const threadId of source.threadIds ?? []) project.threadIds.add(threadId);
  return project;
}

function readHomeMetadata(home, projects, names) {
  const globalStatePath = path.join(home.path, ".codex-global-state.json");
  if (fs.existsSync(globalStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
      const localProjects = state["local-projects"] ?? {};
      const assignments = state["thread-project-assignments"] ?? {};
      for (const [legacyId, value] of Object.entries(localProjects)) {
        const threadIds = Object.entries(assignments)
          .filter(([, assignment]) => assignment?.projectId === legacyId)
          .map(([threadId]) => threadId);
        addProject(projects, {
          id: legacyId,
          name: value.name,
          roots: value.rootPaths,
          threadIds,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt
        });
      }
    } catch {}
  }
  readSessionNames(path.join(home.path, "session_index.jsonl"), names);
  const dbPath = stateDbPath(home.path);
  if (!dbPath) return;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const projectRows = db.prepare("SELECT id, name, created_at_ms, updated_at_ms FROM projects ORDER BY position").all();
    const rootRows = db.prepare("SELECT project_id, path FROM project_roots ORDER BY project_id, position").all();
    const rootsById = new Map();
    for (const row of rootRows) {
      const list = rootsById.get(row.project_id) ?? [];
      list.push(row.path);
      rootsById.set(row.project_id, list);
    }
    for (const row of projectRows) {
      const threadIds = db.prepare("SELECT id FROM threads WHERE project_id = ?").all(row.id).map((entry) => entry.id);
      addProject(projects, {
        id: row.id,
        name: row.name,
        roots: rootsById.get(row.id) ?? [],
        threadIds,
        createdAt: row.created_at_ms,
        updatedAt: row.updated_at_ms
      });
    }
    for (const row of db.prepare("SELECT id, name FROM threads WHERE name IS NOT NULL AND length(name) > 0").all()) {
      if (!names.has(row.id)) names.set(row.id, { name: row.name, updatedAt: 0 });
    }
    db.close();
  } catch {}
}

export async function collectUiMetadata(config, dataRepoRoot) {
  const projects = new Map();
  const names = new Map();
  const metadataPath = path.join(dataRepoRoot, "data", "ui-metadata.json");
  let previous = { projects: [], threadNames: {} };
  try {
    previous = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
    for (const project of previous.projects ?? []) addProject(projects, project);
    for (const [threadId, name] of Object.entries(previous.threadNames ?? {})) {
      if (typeof name === "string" && name.trim()) names.set(threadId, { name, updatedAt: 0 });
    }
  } catch {}
  for (const home of config.homes) readHomeMetadata(home, projects, names);
  readSessionNames(path.join(dataRepoRoot, "data", "session_index.jsonl"), names);
  const content = {
    schemaVersion: 1,
    projects: [...projects.values()].map((project) => ({
      id: project.id,
      name: project.name,
      roots: [...project.roots],
      threadIds: [...project.threadIds],
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    })),
    threadNames: Object.fromEntries([...names].map(([threadId, value]) => [threadId, value.name]))
  };
  const comparablePrevious = { schemaVersion: previous.schemaVersion, projects: previous.projects ?? [], threadNames: previous.threadNames ?? {} };
  const changed = JSON.stringify(content) !== JSON.stringify(comparablePrevious);
  const metadata = { ...content, updatedAt: changed ? new Date().toISOString() : previous.updatedAt ?? new Date().toISOString() };
  if (changed || !(await exists(metadataPath))) {
    await fsp.mkdir(path.dirname(metadataPath), { recursive: true });
    await fsp.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  return metadata;
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

function createRpcClient(executable, homePath, timeoutMs) {
  const child = spawn(executable, ["app-server"], {
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: homePath }
  });
  let buffer = "";
  let sequence = 0;
  const pending = new Map();
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
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(message.error);
      else request.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`app-server exited with code ${code}`));
    }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  return { child, call, notify };
}

async function listAllThreads(client) {
  const threads = [];
  for (const archived of [false, true]) {
    let cursor = null;
    do {
      const page = await client.call("thread/list", { limit: 100, archived, useStateDbOnly: false, ...(cursor ? { cursor } : {}) });
      threads.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  return threads;
}

async function backupMetadata(homePath, dbPath, { includeDatabase = true, includeGlobalState = true } = {}) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const root = path.join(homePath, "backups_state", "history-metadata", stamp);
  await fsp.mkdir(root, { recursive: true });
  const globalState = path.join(homePath, ".codex-global-state.json");
  if (includeGlobalState && await exists(globalState)) await fsp.copyFile(globalState, path.join(root, ".codex-global-state.json"));
  if (includeDatabase && dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { await sqliteBackup(db, path.join(root, "state_5.sqlite")); } finally { db.close(); }
  }
  return root;
}

export async function applyUiMetadata(config, home, metadata) {
  if (config.sync.includeUiMetadata === false) return { skipped: true, reason: "disabled" };
  const executable = await discoverCodexExecutable(home.path);
  if (!executable) return { skipped: true, reason: "codex-cli-not-found" };
  const timeoutMs = Math.max(10, Number(config.sync.indexRefreshTimeoutSeconds ?? 120)) * 1000;
  const client = createRpcClient(executable, home.path, timeoutMs);
  const appProjectByCanonicalId = new Map();
  let threadCount = 0;
  let projectAssignments = 0;
  let nameUpdates = 0;
  try {
    await client.call("initialize", {
      clientInfo: { name: "codex_history_sync", title: "Codex History Sync", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    client.notify("initialized", {});
    const threads = await listAllThreads(client);
    threadCount = threads.length;
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const projectPage = await client.call("project/list", { limit: 100 });
    const existingProjects = projectPage.data ?? [];
    const existingByRoots = new Map(existingProjects.map((project) => [rootsKey(project.roots?.map((root) => root.path) ?? []), project]));
    for (const project of metadata.projects ?? []) {
      const key = rootsKey(project.roots ?? []);
      let target = existingByRoots.get(key);
      if (!target) {
        target = (await client.call("project/import", {
          name: project.name,
          roots: (project.roots ?? []).map((rootPath) => ({ path: rootPath })),
          metadata: {},
          threads: (project.threadIds ?? []).filter((threadId) => threadById.has(threadId)),
          idempotencyKey: `codex-history-sync:${crypto.createHash("sha256").update(key || project.id).digest("hex")}`
        })).project;
        existingByRoots.set(key, target);
      }
      appProjectByCanonicalId.set(project.id, target.id);
      for (const threadId of project.threadIds ?? []) {
        if (!threadById.has(threadId)) continue;
        if (threadById.get(threadId)?.projectId === target.id) continue;
        try {
          await client.call("thread/metadata/update", { threadId, projectId: target.id });
          projectAssignments += 1;
          threadById.get(threadId).projectId = target.id;
        } catch {}
      }
    }
    for (const [threadId, name] of Object.entries(metadata.threadNames ?? {})) {
      const current = threadById.get(threadId);
      if (!current || current.name === name) continue;
      try {
        await client.call("thread/name/set", { threadId, name });
        nameUpdates += 1;
      } catch {}
    }
  } finally {
    client.child.kill();
  }

  const dbPath = stateDbPath(home.path);
  const globalStatePath = path.join(home.path, ".codex-global-state.json");
  let dbNeedsUpdate = false;
  let dbUpdates = { names: 0, projects: 0 };
  if (dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const threadRows = new Map(db.prepare("SELECT id, name, project_id FROM threads").all().map((row) => [row.id, row]));
      for (const [threadId, name] of Object.entries(metadata.threadNames ?? {})) {
        const row = threadRows.get(threadId);
        if (row && row.name !== name) dbUpdates.names += 1;
      }
      for (const project of metadata.projects ?? []) {
        const appProjectId = appProjectByCanonicalId.get(project.id);
        if (!appProjectId) continue;
        for (const threadId of project.threadIds ?? []) {
          const row = threadRows.get(threadId);
          if (row && row.project_id !== appProjectId) dbUpdates.projects += 1;
        }
      }
      dbNeedsUpdate = dbUpdates.names > 0 || dbUpdates.projects > 0;
    } finally {
      db.close();
    }
  }

  let state = {};
  try { state = JSON.parse(await fsp.readFile(globalStatePath, "utf8")); } catch {}
  const originalStateText = JSON.stringify(state);
  const localProjects = { ...(state["local-projects"] ?? {}) };
  const assignments = { ...(state["thread-project-assignments"] ?? {}) };
  const projectOrder = [...(state["project-order"] ?? [])];
  for (const project of metadata.projects ?? []) {
    localProjects[project.id] = {
      id: project.id,
      name: project.name,
      rootPaths: project.roots ?? [],
      createdAt: project.createdAt ?? Date.now(),
      updatedAt: project.updatedAt ?? Date.now()
    };
    if (!projectOrder.includes(project.id)) projectOrder.push(project.id);
    for (const threadId of project.threadIds ?? []) assignments[threadId] = { projectKind: "local", projectId: project.id };
  }
  state["local-projects"] = localProjects;
  state["thread-project-assignments"] = assignments;
  state["project-order"] = projectOrder.filter((id, index, values) => localProjects[id] && values.indexOf(id) === index);
  state["projectless-thread-ids"] = (state["projectless-thread-ids"] ?? []).filter((threadId) => !assignments[threadId]);
  const hostKey = `local:${home.path.replaceAll("/", "\\")}`;
  const projectMappings = { ...(state["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ?? {}) };
  for (const [canonicalId, appProjectId] of appProjectByCanonicalId) projectMappings[canonicalId] = appProjectId;
  state["app-server-project-id-by-legacy-project-id-by-host"] = {
    ...(state["app-server-project-id-by-legacy-project-id-by-host"] ?? {}),
    [hostKey]: projectMappings
  };
  state["app-server-projects-migration-by-host"] = {
    ...(state["app-server-projects-migration-by-host"] ?? {}),
    [hostKey]: { version: 1, projectsMigrated: true, threadAssignmentsMigrated: true, pendingThreadAssignmentIds: [] }
  };
  const desiredStateText = JSON.stringify(state);
  const stateNeedsUpdate = desiredStateText !== originalStateText;
  let backupDir = null;
  if (dbNeedsUpdate || stateNeedsUpdate) {
    try {
      backupDir = await backupMetadata(home.path, dbPath, { includeDatabase: dbNeedsUpdate, includeGlobalState: stateNeedsUpdate });
    } catch (error) {
      return {
        ok: false,
        partial: true,
        reason: "backup-failed",
        error: error.message,
        projects: appProjectByCanonicalId.size,
        projectAssignments,
        nameUpdates,
        threadCount
      };
    }
  }
  if (dbPath) {
    if (dbNeedsUpdate) {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const updateName = db.prepare("UPDATE threads SET name = ? WHERE id = ? AND COALESCE(name, '') <> ?");
        const updateProject = db.prepare("UPDATE threads SET project_id = ? WHERE id = ? AND (project_id IS NULL OR project_id <> ?)");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const [threadId, name] of Object.entries(metadata.threadNames ?? {})) updateName.run(name, threadId, name);
          for (const project of metadata.projects ?? []) {
            const appProjectId = appProjectByCanonicalId.get(project.id);
            if (!appProjectId) continue;
            for (const threadId of project.threadIds ?? []) updateProject.run(appProjectId, threadId, appProjectId);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          return { ok: false, partial: true, reason: "database-busy-or-write-failed", error: error.message, projects: appProjectByCanonicalId.size, projectAssignments, nameUpdates, threadCount, backupDir };
        }
      } finally {
        db.close();
      }
    }
  }
  if (stateNeedsUpdate) {
    const temporaryPath = `${globalStatePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(temporaryPath, desiredStateText, "utf8");
    await fsp.rename(temporaryPath, globalStatePath);
  }
  return {
    ok: true,
    projects: appProjectByCanonicalId.size,
    projectAssignments,
    nameUpdates,
    threadCount,
    backupDir,
    databaseUpdates: dbUpdates,
    stateUpdated: stateNeedsUpdate
  };
}

export async function writeUiMetadataState(config, home, metadata, { writeBackupState = false } = {}) {
  if (config.sync.includeUiMetadata === false) return { skipped: true, reason: "disabled" };

  const globalStatePath = path.join(home.path, ".codex-global-state.json");
  let state = {};
  try { state = JSON.parse(await fsp.readFile(globalStatePath, "utf8")); } catch {}

  const localProjects = { ...(state["local-projects"] ?? {}) };
  const assignments = { ...(state["thread-project-assignments"] ?? {}) };
  const projectOrder = [...(state["project-order"] ?? [])];
  const hostKey = `local:${home.path.replaceAll("/", "\\")}`;
  const projectMappings = { ...(state["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ?? {}) };
  const dbPath = stateDbPath(home.path);
  const projectsByRoots = new Map();

  if (dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rootsByProject = new Map();
      for (const row of db.prepare("SELECT project_id, path FROM project_roots ORDER BY project_id, position").all()) {
        const roots = rootsByProject.get(row.project_id) ?? [];
        roots.push(row.path);
        rootsByProject.set(row.project_id, roots);
      }
      for (const row of db.prepare("SELECT id FROM projects").all()) {
        projectsByRoots.set(rootsKey(rootsByProject.get(row.id) ?? []), row.id);
      }
    } finally {
      db.close();
    }
  }

  for (const project of metadata.projects ?? []) {
    localProjects[project.id] = {
      id: project.id,
      name: project.name,
      rootPaths: project.roots ?? [],
      createdAt: project.createdAt ?? Date.now(),
      updatedAt: project.updatedAt ?? Date.now()
    };
    if (!projectOrder.includes(project.id)) projectOrder.push(project.id);
    for (const threadId of project.threadIds ?? []) assignments[threadId] = { projectKind: "local", projectId: project.id };
    const appProjectId = projectsByRoots.get(rootsKey(project.roots ?? []));
    if (appProjectId) projectMappings[project.id] = appProjectId;
  }

  state["local-projects"] = localProjects;
  state["thread-project-assignments"] = assignments;
  state["project-order"] = projectOrder.filter((id, index, values) => localProjects[id] && values.indexOf(id) === index);
  state["projectless-thread-ids"] = (state["projectless-thread-ids"] ?? []).filter((threadId) => !assignments[threadId]);
  state["app-server-project-id-by-legacy-project-id-by-host"] = {
    ...(state["app-server-project-id-by-legacy-project-id-by-host"] ?? {}),
    [hostKey]: projectMappings
  };
  state["app-server-projects-migration-by-host"] = {
    ...(state["app-server-projects-migration-by-host"] ?? {}),
    [hostKey]: { version: 1, projectsMigrated: true, threadAssignmentsMigrated: true, pendingThreadAssignmentIds: [] }
  };

  await fsp.mkdir(home.path, { recursive: true });
  const text = `${JSON.stringify(state)}\n`;
  const temporaryPath = `${globalStatePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporaryPath, text, "utf8");
  await fsp.rename(temporaryPath, globalStatePath);
  if (writeBackupState) await fsp.writeFile(`${globalStatePath}.bak`, text, "utf8");

  return {
    ok: true,
    projects: Object.keys(localProjects).length,
    assignments: Object.keys(assignments).length,
    mappings: Object.keys(projectMappings).length,
    backupStateUpdated: writeBackupState
  };
}
