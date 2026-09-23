import { fileURLToPath } from "node:url";
import path from "node:path";

export function windowsHookCommand(nodePath, hookEntry, mode) {
  if (!["start", "enqueue"].includes(mode)) throw new Error("Invalid hook mode");
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  // Hooks can be launched by either PowerShell or cmd.exe. Keep all paths
  // out of the outer shell and explicitly invoke Node in the inner shell.
  const script = `$ErrorActionPreference = 'Stop'; & ${literal(nodePath)} ${literal(hookEntry)} ${literal(mode)}; exit $LASTEXITCODE`;
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(windowsHookCommand(...process.argv.slice(2)));
}
