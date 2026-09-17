#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(__dirname, "sync-history.mjs");
const exitWatcher = path.join(__dirname, "watch-home-exit.mjs");
const mode = ["start", "enqueue"].includes(process.argv[2]) ? process.argv[2] : "enqueue";

if (mode === "start") {
  const child = spawn(process.execPath, [worker, "start"], {
    cwd: path.resolve(__dirname, ".."),
    windowsHide: true,
    stdio: "inherit"
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const child = spawn(process.execPath, [worker, "enqueue"], {
    cwd: path.resolve(__dirname, ".."),
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  if (process.env.CODEX_HOME) {
    const watcher = spawn(process.execPath, [exitWatcher, process.env.CODEX_HOME], {
      cwd: path.resolve(__dirname, ".."),
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    watcher.unref();
  }
}
