// Fails if any server or browser module has a syntax error. No dependencies:
// uses `node --check` on every .js file outside node_modules.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["server", "scripts", "public/js", "test"];

const files = dirs.flatMap((dir) =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(root, dir, f))
);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}\n${err.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
