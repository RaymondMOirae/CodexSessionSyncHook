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

function homeStateKey(home) {
  return crypto.createHash("sha256").update(`${home.name}\0${home.path}`).digest("hex").slice(0, 16);
}

function projectObservationPath(dataRepoRoot, home) {
  return path.join(dataRepoRoot, ".sync", "project-observations", `${home.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${homeStateKey(home)}.json`);
}

async function metadataDeviceId(dataRepoRoot) {
  const deviceIdPath = path.join(dataRepoRoot, ".sync", "device-id");
  const current = (await fsp.readFile(deviceIdPath, "utf8").catch(() => "")).trim();
  if (current) return current;
  const created = crypto.randomUUID();
  await fsp.mkdir(path.dirname(deviceIdPath), { recursive: true });
  await fsp.writeFile(deviceIdPath, `${created}\n`, { encoding: "utf8", flag: "wx" }).catch(() => {});
  return (await fsp.readFile(deviceIdPath, "utf8").catch(() => created)).trim() || created;
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

function synchronizeArchivedUiState(state, activeThreadIds, archivedThreadIds) {
  if (!activeThreadIds || !archivedThreadIds) return;
  const persisted = state["electron-persisted-atom-state"] && typeof state["electron-persisted-atom-state"] === "object"
    ? { ...state["electron-persisted-atom-state"] }
    : {};
  for (const threadId of activeThreadIds) delete persisted[`codex-writing-block-deleted-thread-v1:${threadId}`];
  for (const threadId of archivedThreadIds) persisted[`codex-writing-block-deleted-thread-v1:${threadId}`] = true;
  state["electron-persisted-atom-state"] = persisted;

  const sidebarOrders = state["sidebar-project-thread-orders"];
  if (sidebarOrders && typeof sidebarOrders === "object") {
    state["sidebar-project-thread-orders"] = Object.fromEntries(Object.entries(sidebarOrders).map(([projectId, order]) => [
      projectId,
      order && typeof order === "object" && Array.isArray(order.threadIds)
        ? { ...order, threadIds: order.threadIds.filter((threadId) => !archivedThreadIds.has(threadId)) }
        : order
    ]));
  }
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
  const observation = { presentKeys: new Set(), deletedHints: new Map(), available: false };
  const globalStatePath = path.join(home.path, ".codex-global-state.json");
  let state = {};
  if (fs.existsSync(globalStatePath)) {
    observation.available = true;
    try {
      state = JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
    } catch {}
  }
  readSessionNames(path.join(home.path, "session_index.jsonl"), names);
  const dbPath = stateDbPath(home.path);
  if (dbPath) observation.available = true;
  const localProjects = state["local-projects"] ?? {};
  const assignments = state["thread-project-assignments"] ?? {};
  const hostKey = `local:${home.path.replaceAll("/", "\\")}`;
  const projectMappings = state["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ?? {};
  const migration = state["app-server-projects-migration-by-host"]?.[hostKey];
  if (!dbPath) {
    for (const [legacyId, value] of Object.entries(localProjects)) {
      const threadIds = Object.entries(assignments)
        .filter(([, assignment]) => assignment?.projectId === legacyId)
        .map(([threadId]) => threadId);
      const project = addProject(projects, {
        id: legacyId,
        name: value.name,
        roots: value.rootPaths,
        threadIds,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt
      });
      observation.presentKeys.add(rootsKey(project.roots));
    }
    return observation;
  }
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
    const dbProjectIds = new Set(projectRows.map((row) => row.id));
    const legacyByAppId = new Map(Object.entries(projectMappings).map(([legacyId, appProjectId]) => [appProjectId, legacyId]));
    const legacyByRoots = new Map(Object.entries(localProjects).map(([legacyId, value]) => [rootsKey(value.rootPaths ?? []), legacyId]));
    for (const row of projectRows) {
      const roots = rootsById.get(row.id) ?? [];
      const legacyId = legacyByAppId.get(row.id) ?? legacyByRoots.get(rootsKey(roots));
      const legacy = legacyId ? localProjects[legacyId] : null;
      const threadIds = db.prepare("SELECT id FROM threads WHERE project_id = ?").all(row.id).map((entry) => entry.id);
      const project = addProject(projects, {
        id: legacyId ?? row.id,
        name: row.name || legacy?.name,
        roots,
        threadIds,
        createdAt: legacy?.createdAt ?? row.created_at_ms,
        updatedAt: Math.max(legacy?.updatedAt ?? 0, row.updated_at_ms ?? 0)
      });
      observation.presentKeys.add(rootsKey(project.roots));
    }
    if (migration?.projectsMigrated === true) {
      for (const [legacyId, value] of Object.entries(localProjects)) {
        const appProjectId = projectMappings[legacyId];
        if (!appProjectId || dbProjectIds.has(appProjectId)) continue;
        const roots = Array.isArray(value.rootPaths) ? value.rootPaths.map(String).filter(Boolean) : [];
        const key = rootsKey(roots) || `id:${legacyId}`;
        observation.deletedHints.set(key, { id: legacyId, name: value.name, roots });
      }
    }
    for (const row of db.prepare("SELECT id, name FROM threads WHERE name IS NOT NULL AND length(name) > 0").all()) {
      if (!names.has(row.id)) names.set(row.id, { name: row.name, updatedAt: 0 });
    }
    db.close();
  } catch {}
  return observation;
}

function newerProjectEvent(current, candidate) {
  if (!current) return candidate;
  if (candidate.observedAtMs !== current.observedAtMs) return candidate.observedAtMs > current.observedAtMs ? candidate : current;
  if (candidate.deleted !== current.deleted) return candidate.deleted ? candidate : current;
  return String(candidate.source).localeCompare(String(current.source)) > 0 ? candidate : current;
}

async function loadProjectEvents(dataRepoRoot) {
  const latest = new Map();
  const root = path.join(dataRepoRoot, "data", "project-events");
  if (!(await exists(root))) return latest;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        let event;
        try { event = JSON.parse(await fsp.readFile(full, "utf8")); } catch { continue; }
        if (typeof event?.key !== "string" || typeof event?.deleted !== "boolean") continue;
        const observedAtMs = Number(event.observedAtMs) || Date.parse(event.observedAt ?? "") || 0;
        const normalized = { ...event, observedAtMs, source: event.source ?? "unknown" };
        latest.set(event.key, newerProjectEvent(latest.get(event.key), normalized));
      }
    }
  }
  return latest;
}

async function appendProjectEvent(dataRepoRoot, event) {
  const eventRoot = path.join(dataRepoRoot, "data", "project-events", crypto.createHash("sha256").update(event.key).digest("hex"));
  await fsp.mkdir(eventRoot, { recursive: true });
  const fileName = `${String(event.observedAtMs).padStart(13, "0")}-${event.source.replace(/[^A-Za-z0-9._-]/g, "_")}-${crypto.randomUUID()}.json`;
  await fsp.writeFile(path.join(eventRoot, fileName), `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function loadDeletedThreadIds(dataRepoRoot) {
  const deleted = new Set();
  const root = path.join(dataRepoRoot, "data", "delete-events");
  if (!(await exists(root))) return deleted;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        let event;
        try { event = JSON.parse(await fsp.readFile(full, "utf8")); } catch { continue; }
        if (typeof event?.id === "string" && event.deleted === true) deleted.add(event.id);
      }
    }
  }
  return deleted;
}

async function resolveProjectEvents(config, dataRepoRoot, observations, previousProjects) {
  const latest = await loadProjectEvents(dataRepoRoot);
  if (config.sync.propagateDeletes !== true) return latest;
  const deviceId = await metadataDeviceId(dataRepoRoot);
  const snapshots = new Map();
  for (const home of config.homes) {
    let snapshot = { states: {} };
    try { snapshot = JSON.parse(await fsp.readFile(projectObservationPath(dataRepoRoot, home), "utf8")); } catch {}
    snapshots.set(home.name, snapshot.states ?? {});
  }
  const keys = new Set([
    ...latest.keys(),
    ...previousProjects.map((project) => rootsKey(project.roots ?? []) || `id:${project.id}`),
    ...[...observations.values()].flatMap((observation) => [...observation.presentKeys, ...observation.deletedHints.keys()]),
    ...[...snapshots.values()].flatMap((states) => Object.keys(states))
  ]);
  for (const key of keys) {
    const changes = [];
    let descriptor = null;
    for (const home of config.homes) {
      const observation = observations.get(home.name) ?? { presentKeys: new Set(), deletedHints: new Map() };
      if (observation.available === false) continue;
      const hint = observation.deletedHints.get(key);
      if (hint) {
        descriptor ??= hint;
        if (latest.get(key)?.deleted !== true) changes.push({ home: home.name, deleted: true, reason: "deleted-mapping" });
        continue;
      }
      const prior = snapshots.get(home.name)?.[key];
      const present = observation.presentKeys.has(key);
      if (typeof prior === "boolean" && prior !== present && latest.get(key)?.deleted !== !present) {
        changes.push({ home: home.name, deleted: !present, reason: "presence-transition" });
      }
    }
    if (changes.length === 0) continue;
    const deleted = changes.some((entry) => entry.deleted);
    const observedAtMs = Math.max(Date.now(), (latest.get(key)?.observedAtMs ?? 0) + 1);
    const event = {
      schemaVersion: 1,
      key,
      id: descriptor?.id ?? latest.get(key)?.id ?? null,
      name: descriptor?.name ?? latest.get(key)?.name ?? null,
      roots: descriptor?.roots ?? latest.get(key)?.roots ?? key.split("|").filter((entry) => !entry.startsWith("id:")),
      deleted,
      observedAt: new Date(observedAtMs).toISOString(),
      observedAtMs,
      source: `${deviceId}:${changes.map((entry) => entry.home).sort().join(",")}${deleted && changes.some((entry) => !entry.deleted) ? ":delete-wins" : ""}`
    };
    await appendProjectEvent(dataRepoRoot, event);
    latest.set(key, event);
  }
  return latest;
}

export async function collectUiMetadata(config, dataRepoRoot) {
  const projects = new Map();
  const names = new Map();
  const observations = new Map();
  const metadataPath = path.join(dataRepoRoot, "data", "ui-metadata.json");
  let previous = { projects: [], threadNames: {} };
  try {
    previous = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
    for (const project of previous.projects ?? []) addProject(projects, project);
    for (const [threadId, name] of Object.entries(previous.threadNames ?? {})) {
      if (typeof name === "string" && name.trim()) names.set(threadId, { name, updatedAt: 0 });
    }
  } catch {}
  for (const home of config.homes) observations.set(home.name, readHomeMetadata(home, projects, names));
  const projectEvents = await resolveProjectEvents(config, dataRepoRoot, observations, previous.projects ?? []);
  const deletedThreadIds = config.sync.propagateDeletes === true ? await loadDeletedThreadIds(dataRepoRoot) : new Set();
  readSessionNames(path.join(dataRepoRoot, "data", "session_index.jsonl"), names);
  const content = {
    schemaVersion: 1,
    projects: [...projects.entries()].filter(([key]) => projectEvents.get(key)?.deleted !== true).map(([, project]) => ({
      id: project.id,
      name: project.name,
      roots: [...project.roots],
      threadIds: [...project.threadIds].filter((threadId) => !deletedThreadIds.has(threadId)),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    })),
    threadNames: Object.fromEntries([...names].filter(([threadId]) => !deletedThreadIds.has(threadId)).map(([threadId, value]) => [threadId, value.name]))
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
      threads.push(...(page.data ?? []).map((thread) => ({ ...thread, __syncArchived: archived })));
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
  const dbPath = stateDbPath(home.path);
  const globalStatePath = path.join(home.path, ".codex-global-state.json");
  const timeoutMs = Math.max(10, Number(config.sync.indexRefreshTimeoutSeconds ?? 120)) * 1000;
  const client = createRpcClient(executable, home.path, timeoutMs);
  const appProjectByCanonicalId = new Map();
  let threadCount = 0;
  let projectAssignments = 0;
  let projectDeletes = 0;
  let nameUpdates = 0;
  let backupDir = null;
  const newlyProjectlessThreadIds = new Set();
  const activeThreadIdsForUi = new Set();
  const archivedThreadIdsForUi = new Set();
  try {
    await client.call("initialize", {
      clientInfo: { name: "codex_history_sync", title: "Codex History Sync", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    client.notify("initialized", {});
    const threads = await listAllThreads(client);
    threadCount = threads.length;
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of threads) {
      if (thread.__syncArchived) archivedThreadIdsForUi.add(thread.id);
      else activeThreadIdsForUi.add(thread.id);
    }
    const projectPage = await client.call("project/list", { limit: 100 });
    const existingProjects = projectPage.data ?? [];
    const existingByRoots = new Map(existingProjects.map((project) => [rootsKey(project.roots?.map((root) => root.path) ?? []), project]));
    const desiredProjectKeys = new Set((metadata.projects ?? []).map((project) => rootsKey(project.roots ?? [])));
    if (config.sync.propagateDeletes === true) {
      for (const existing of existingProjects) {
        const key = rootsKey(existing.roots?.map((root) => root.path) ?? []);
        if (desiredProjectKeys.has(key)) continue;
        if (!backupDir) backupDir = await backupMetadata(home.path, dbPath);
        for (const thread of threadById.values()) {
          if (thread.projectId === existing.id && !thread.__syncArchived) newlyProjectlessThreadIds.add(thread.id);
        }
        await client.call("project/delete", { projectId: existing.id });
        existingByRoots.delete(key);
        projectDeletes += 1;
      }
    }
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
  const previousAssignments = state["thread-project-assignments"] ?? {};
  const localProjects = config.sync.propagateDeletes === true ? {} : { ...(state["local-projects"] ?? {}) };
  const assignments = config.sync.propagateDeletes === true
    ? Object.fromEntries(Object.entries(previousAssignments).filter(([, assignment]) => assignment?.projectKind !== "local"))
    : { ...previousAssignments };
  const previousProjectOrder = [...(state["project-order"] ?? [])];
  const projectOrder = config.sync.propagateDeletes === true ? [] : [...previousProjectOrder];
  for (const project of metadata.projects ?? []) {
    localProjects[project.id] = {
      id: project.id,
      name: project.name,
      rootPaths: project.roots ?? [],
      createdAt: project.createdAt ?? Date.now(),
      updatedAt: project.updatedAt ?? Date.now()
    };
    if (!projectOrder.includes(project.id)) projectOrder.push(project.id);
    for (const threadId of project.threadIds ?? []) {
      if (activeThreadIdsForUi.has(threadId)) assignments[threadId] = { projectKind: "local", projectId: project.id };
    }
  }
  state["local-projects"] = localProjects;
  state["thread-project-assignments"] = assignments;
  const desiredOrder = [
    ...previousProjectOrder.filter((id) => localProjects[id]),
    ...projectOrder
  ].filter((id, index, values) => localProjects[id] && values.indexOf(id) === index);
  state["project-order"] = desiredOrder;
  const projectless = new Set((state["projectless-thread-ids"] ?? []).filter((threadId) => activeThreadIdsForUi.has(threadId) && !assignments[threadId]));
  for (const threadId of newlyProjectlessThreadIds) if (!assignments[threadId]) projectless.add(threadId);
  state["projectless-thread-ids"] = [...projectless];
  synchronizeArchivedUiState(state, activeThreadIdsForUi, archivedThreadIdsForUi);
  const hostKey = `local:${home.path.replaceAll("/", "\\")}`;
  const projectMappings = config.sync.propagateDeletes === true
    ? {}
    : { ...(state["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ?? {}) };
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
  if (dbNeedsUpdate || stateNeedsUpdate) {
    try {
      backupDir ??= await backupMetadata(home.path, dbPath, { includeDatabase: dbNeedsUpdate, includeGlobalState: stateNeedsUpdate });
    } catch (error) {
      return {
        ok: false,
        partial: true,
        reason: "backup-failed",
        error: error.message,
        projects: appProjectByCanonicalId.size,
        projectDeletes,
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
          return { ok: false, partial: true, reason: "database-busy-or-write-failed", error: error.message, projects: appProjectByCanonicalId.size, projectDeletes, projectAssignments, nameUpdates, threadCount, backupDir };
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
    projectDeletes,
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

  const previousAssignments = state["thread-project-assignments"] ?? {};
  const localProjects = config.sync.propagateDeletes === true ? {} : { ...(state["local-projects"] ?? {}) };
  const assignments = config.sync.propagateDeletes === true
    ? Object.fromEntries(Object.entries(previousAssignments).filter(([, assignment]) => assignment?.projectKind !== "local"))
    : { ...previousAssignments };
  const previousProjectOrder = [...(state["project-order"] ?? [])];
  const projectOrder = config.sync.propagateDeletes === true ? [] : [...previousProjectOrder];
  const hostKey = `local:${home.path.replaceAll("/", "\\")}`;
  const projectMappings = config.sync.propagateDeletes === true
    ? {}
    : { ...(state["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ?? {}) };
  const dbPath = stateDbPath(home.path);
  const projectsByRoots = new Map();
  let activeThreadIdsForUi = null;
  let archivedThreadIdsForUi = null;

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
      const threadColumns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
      if (threadColumns.has("archived")) {
        const archiveRows = db.prepare("SELECT id, archived FROM threads").all();
        activeThreadIdsForUi = new Set(archiveRows.filter((row) => !row.archived).map((row) => row.id));
        archivedThreadIdsForUi = new Set(archiveRows.filter((row) => Boolean(row.archived)).map((row) => row.id));
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
    for (const threadId of project.threadIds ?? []) {
      if (!activeThreadIdsForUi || activeThreadIdsForUi.has(threadId)) assignments[threadId] = { projectKind: "local", projectId: project.id };
    }
    const appProjectId = projectsByRoots.get(rootsKey(project.roots ?? []));
    if (appProjectId) projectMappings[project.id] = appProjectId;
  }

  state["local-projects"] = localProjects;
  state["thread-project-assignments"] = assignments;
  state["project-order"] = [
    ...previousProjectOrder.filter((id) => localProjects[id]),
    ...projectOrder
  ].filter((id, index, values) => localProjects[id] && values.indexOf(id) === index);
  state["projectless-thread-ids"] = (state["projectless-thread-ids"] ?? []).filter((threadId) => (!activeThreadIdsForUi || activeThreadIdsForUi.has(threadId)) && !assignments[threadId]);
  synchronizeArchivedUiState(state, activeThreadIdsForUi, archivedThreadIdsForUi);
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

export async function writeUiMetadataObservations(config, dataRepoRoot, metadata) {
  const events = await loadProjectEvents(dataRepoRoot);
  const knownKeys = new Set([
    ...events.keys(),
    ...(metadata.projects ?? []).map((project) => rootsKey(project.roots ?? []) || `id:${project.id}`)
  ]);
  const observations = new Map();
  for (const home of config.homes) {
    const observation = readHomeMetadata(home, new Map(), new Map());
    observations.set(home.name, observation);
    for (const key of observation.presentKeys) knownKeys.add(key);
    for (const key of observation.deletedHints.keys()) knownKeys.add(key);
  }
  for (const home of config.homes) {
    const observation = observations.get(home.name);
    if (observation.available === false) continue;
    const snapshotPath = projectObservationPath(dataRepoRoot, home);
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsp.writeFile(snapshotPath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      states: Object.fromEntries([...knownKeys].map((key) => [key, observation.presentKeys.has(key)]))
    }, null, 2)}\n`, "utf8");
  }
}
