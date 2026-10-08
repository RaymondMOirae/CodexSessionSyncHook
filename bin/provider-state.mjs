import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stateKey = (item) => ["reasoning", "compaction"].includes(item?.type) && typeof item.id === "string"
  ? `${item.type}:${item.id}` : null;

export async function isThreadWriterLocked(homePath, threadId) {
  if (!/^[a-z0-9-]+$/i.test(threadId)) throw new Error("Invalid thread identity");
  let handle;
  try {
    handle = await fs.open(path.join(homePath, "thread-writer-locks", `${threadId}.lock`), "r");
    // Opening succeeds on Windows even when Core holds a byte-range lock.
    // Reading a byte actually tests that lock, including a zero-length file.
    await handle.read(Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (["EBUSY", "EACCES", "EPERM"].includes(error.code)) return true;
    throw error;
  } finally { await handle?.close(); }
}

function visit(value, fn) {
  if (!value || typeof value !== "object") return;
  fn(value);
  for (const child of Object.values(value)) visit(child, fn);
}

// These are opaque history items, not credentials. Keep them in the private
// history repository, partitioned by provider; never import them across providers.
export class ProviderStateStore {
  constructor(dataRoot) { this.root = path.join(dataRoot, "data", "provider-state"); this.entries = new Map(); }

  async state(threadId, provider) {
    if (!/^[a-z0-9-]+$/i.test(threadId) || !provider) throw new Error("Invalid provider-state identity");
    const key = `${threadId}:${provider}`;
    if (!this.entries.has(key)) {
      const file = path.join(this.root, hash(provider).slice(0, 24), `${threadId}.json`);
      let data;
      try { data = JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      data ??= { schemaVersion: 1, threadId, provider, items: {} };
      if (data.schemaVersion !== 1 || data.threadId !== threadId || data.provider !== provider || !data.items) throw new Error("Provider-state identity mismatch");
      this.entries.set(key, { file, data, dirty: false });
    }
    return this.entries.get(key);
  }

  async capture(threadId, provider, records) {
    const state = await this.state(threadId, provider);
    let added = 0;
    for (const record of records) visit(record, (item) => {
      const key = stateKey(item);
      if (!key || typeof item.encrypted_content !== "string" || !item.encrypted_content) return;
      const values = state.data.items[key] ??= [];
      if (!values.includes(item.encrypted_content)) { values.push(item.encrypted_content); added++; state.dirty = true; }
    });
    return added;
  }

  async restorer(threadId, provider) {
    const { data } = await this.state(threadId, provider);
    return (record) => {
      let restored = 0;
      visit(record, (item) => {
        const values = data.items[stateKey(item)];
        // Never replace present ciphertext or guess between conflicting versions.
        if (!item.encrypted_content && values?.length === 1) { item.encrypted_content = values[0]; restored++; }
      });
      return restored;
    };
  }

  async save() {
    for (const state of this.entries.values()) if (state.dirty) {
      await fs.mkdir(path.dirname(state.file), { recursive: true });
      const temp = `${state.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(state.data)}\n`, "utf8");
      await fs.rename(temp, state.file);
      state.dirty = false;
    }
  }

  async deleteThread(threadId) {
    if (!/^[a-z0-9-]+$/i.test(threadId)) throw new Error("Invalid thread identity");
    const directories = await fs.readdir(this.root, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    for (const directory of directories) if (directory.isDirectory() && /^[0-9a-f]{24}$/.test(directory.name)) {
      await fs.rm(path.join(this.root, directory.name, `${threadId}.json`), { force: true });
    }
    for (const [key, state] of this.entries) if (state.data.threadId === threadId) this.entries.delete(key);
  }
}
