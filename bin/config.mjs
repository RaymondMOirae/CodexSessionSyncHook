import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function expandUserPath(value, baseDirectory = process.cwd()) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Path must not be empty.");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDirectory, raw);
}

export async function readToolConfig(repoRoot) {
  const configPath = path.join(repoRoot, "sync.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!Array.isArray(config.homes) || config.homes.length === 0) {
    throw new Error("sync.config.json must contain at least one home.");
  }
  const seenNames = new Set();
  const seenPaths = new Set();
  config.homes = config.homes.map((home, index) => {
    const name = String(home.name ?? `home-${index + 1}`).trim();
    const homePath = expandUserPath(home.path, repoRoot);
    if (seenNames.has(name)) throw new Error(`Duplicate home name: ${name}`);
    if (seenPaths.has(homePath.toLowerCase())) throw new Error(`Duplicate home path: ${homePath}`);
    seenNames.add(name);
    seenPaths.add(homePath.toLowerCase());
    return { ...home, name, path: homePath, installHooks: home.installHooks !== false };
  });
  config.git ??= {};
  config.git.dataRepository = expandUserPath(config.git.dataRepository ?? ".", repoRoot);
  config.git.remote ??= "origin";
  config.git.branch ??= "main";
  return { configPath, config };
}

export async function writeToolConfig(repoRoot, config) {
  const configPath = path.join(repoRoot, "sync.config.json");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}
