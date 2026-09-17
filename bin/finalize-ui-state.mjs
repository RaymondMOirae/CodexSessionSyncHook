#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readToolConfig } from "./config.mjs";
import { collectUiMetadata, writeUiMetadataState } from "./ui-metadata.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const requestedHome = process.argv[2] ?? null;

async function main() {
  const { config } = await readToolConfig(repoRoot);
  const homes = requestedHome ? config.homes.filter((home) => home.name === requestedHome) : config.homes;
  if (requestedHome && homes.length === 0) throw new Error(`Unknown Codex home: ${requestedHome}`);
  const metadata = await collectUiMetadata(config, config.git.dataRepository);
  const results = {};
  for (const home of homes) results[home.name] = await writeUiMetadataState(config, home, metadata, { writeBackupState: true });
  console.log(JSON.stringify({ ok: true, results }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
