import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProviderStateStore } from "../bin/provider-state.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("retains nested compaction state by provider and refuses ambiguous ciphertext", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-state-"));
  try {
    const store = new ProviderStateStore(root);
    const record = { type: "compacted", payload: { replacement_history: [{ type: "compaction", id: "cmp_1", encrypted_content: "official-only" }] } };
    await store.capture("thread", "openai", [record]); await store.save();
    const reopened = new ProviderStateStore(root);
    const missing = { type: "compaction", id: "cmp_1" };
    assert.equal((await reopened.restorer("thread", "api"))(missing), 0);
    assert.equal((await reopened.restorer("thread", "openai"))(missing), 1);
    assert.equal(missing.encrypted_content, "official-only");
    await reopened.capture("thread", "openai", [{ ...missing, encrypted_content: "different-version" }]);
    assert.equal((await reopened.restorer("thread", "openai"))({ type: "compaction", id: "cmp_1" }), 0);
    const present = { ...missing, encrypted_content: "keep-current" };
    (await reopened.restorer("thread", "openai"))(present);
    assert.equal(present.encrypted_content, "keep-current");
    await reopened.save();
    await reopened.deleteThread("thread");
    assert.equal((await reopened.restorer("thread", "openai"))({ type: "compaction", id: "cmp_1" }), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("round trips new turns without erasing official reasoning or compaction state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-roundtrip-"));
  try {
    const framework = path.join(root, "framework"), a = path.join(root, "official"), b = path.join(root, "api"), records = path.join(root, "records");
    await fs.cp(path.join(repo, "bin"), path.join(framework, "bin"), { recursive: true });
    for (const home of [a,b]) await fs.mkdir(path.join(home,"sessions/2026/01/01"),{recursive:true});
    await fs.mkdir(records,{recursive:true});
    await fs.writeFile(path.join(a,"config.toml"),'model_provider = "openai"\n');
    await fs.writeFile(path.join(b,"config.toml"),'model_provider = "other"\n');
    const id = "11111111-1111-7111-8111-111111111111", name = `rollout-2026-01-01T00-00-00-${id}.jsonl`;
    const initial = [
      {type:"session_meta",payload:{id,model_provider:"openai",timestamp:"2026-01-01T00:00:00Z"}},
      {type:"response_item",payload:{type:"reasoning",id:"rs_1",summary:[],encrypted_content:"private-reasoning"}},
      {type:"compacted",payload:{replacement_history:[{type:"compaction",id:"cmp_1",encrypted_content:"private-compaction"}]}}
    ];
    await fs.writeFile(path.join(a,"sessions/2026/01/01",name),initial.map(JSON.stringify).join("\n")+"\n");
    await fs.writeFile(path.join(framework,"sync.config.json"),JSON.stringify({homes:[{name:"a",path:a},{name:"b",path:b}],git:{dataRepository:records,autoPull:false,autoPush:false},providerSync:{enabled:false},sync:{includeArchived:false,includeSessionIndex:false,refreshThreadIndex:false,includeUiMetadata:false,settleMilliseconds:0}}));
    function sync(){const r=spawnSync(process.execPath,[path.join(framework,"bin/sync-history.mjs"),"sync","--no-pull","--no-push","--no-commit"],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).summary;}
    sync();
    async function find(home) { const files = await fs.readdir(path.join(home,"sessions"),{recursive:true}); return path.join(home,"sessions",files.find(file=>file.endsWith(name))); }
    const destinationB=await find(b), destinationA=await find(a);
    assert.doesNotMatch(await fs.readFile(destinationB,"utf8"),/private-reasoning|private-compaction/);
    await fs.appendFile(destinationB,JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"new API turn"}})+"\n");
    sync();
    const official=await fs.readFile(destinationA,"utf8");
    assert.match(official,/new API turn/);
    assert.match(official,/private-reasoning/);
    assert.match(official,/private-compaction/);
    assert.doesNotMatch(await fs.readFile(destinationB,"utf8"),/private-reasoning|private-compaction/);
    sync();
    assert.equal(await fs.readFile(destinationA,"utf8"),official);
    const stateFiles=await fs.readdir(path.join(records,"data/provider-state"),{recursive:true});
    assert.ok(stateFiles.some(file=>file.endsWith(`${id}.json`)));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
