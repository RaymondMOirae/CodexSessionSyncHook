import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installCodexHooks } from "../bin/install.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const installer of ["node", "powershell"]) {
  test(`${installer} installer hooks run in Windows shells and preserve failures`,
    { skip: process.platform !== "win32" }, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-hook-command-"));
      t.after(async () => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        await fs.rm(root, { recursive: true, force: true });
      });
      const framework = path.join(root, "中文 space $literal & it's");
      const home = path.join(root, "home");
      await fs.mkdir(path.join(framework, "bin"), { recursive: true });
      await fs.mkdir(home);
      await fs.writeFile(path.join(framework, "sync.config.json"), JSON.stringify({
        homes: [{ name: "fixture", path: home }], git: { dataRepository: root }
      }));
      const entry = path.join(framework, "bin", "hook-entry.mjs");
      await fs.writeFile(entry, `console.log(JSON.stringify({ mode: process.argv[2] })); process.exitCode = process.argv[2] === "start" ? 0 : 7;\n`);
      for (const file of ["install-hooks.ps1", "hook-command.mjs"]) {
        await fs.copyFile(path.join(repoRoot, "bin", file), path.join(framework, "bin", file));
      }
      if (installer === "node") {
        await installCodexHooks(framework);
      } else {
        const result = spawnSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", path.join(framework, "bin", "install-hooks.ps1"), "-RepoRoot", framework
        ], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
        assert.equal(result.status, 0, result.stderr);
      }
      const hooks = JSON.parse((await fs.readFile(path.join(home, "hooks.json"), "utf8")).replace(/^\uFEFF/, "")).hooks;
      for (const [event, mode, exitCode] of [["SessionStart", "start", 0], ["SessionEnd", "enqueue", 7]]) {
        const hook = hooks[event][0].hooks[0];
        assert.equal(hook.command, hook.commandWindows);
        for (const shell of ["powershell.exe", "cmd.exe"]) {
          const args = shell === "cmd.exe"
            ? ["/d", "/s", "/c", hook.commandWindows]
            : ["-NoProfile", "-NonInteractive", "-Command", hook.commandWindows];
          const result = spawnSync(shell, args, {
            cwd: root, encoding: "utf8", windowsHide: true,
            windowsVerbatimArguments: shell === "cmd.exe", timeout: 10_000
          });
          // PowerShell -Command maps an unhandled native failure to code 1.
          const expected = shell === "powershell.exe" && exitCode !== 0 ? 1 : exitCode;
          assert.equal(result.status, expected, `${event} via ${shell}: ${result.stderr}`);
          assert.deepEqual(JSON.parse(result.stdout.trim()), { mode });
        }
      }
    });
}
