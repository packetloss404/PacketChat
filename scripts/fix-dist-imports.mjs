import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = [
  "agent-runtime",
  "auth",
  "config",
  "contracts",
  "db",
  "files",
  "jobs",
  "observability",
  "providers"
];

const roots = ["apps/worker/dist", ...PACKAGES.map((name) => `packages/${name}/dist`)];

const specifier = /(\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["']|\bimport\s+["'])(\.\.?\/[^"']+)(["'])/g;
const hasExtension = /\.(js|mjs|cjs|json|node)$/;

function normalize(file) {
  const source = readFileSync(file, "utf8");
  let changed = false;
  const output = source.replace(specifier, (match, prefix, spec, suffix) => {
    if (hasExtension.test(spec)) return match;
    changed = true;
    return `${prefix}${spec}.js${suffix}`;
  });
  if (changed) writeFileSync(file, output);
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith(".js")) normalize(path);
  }
}

let scanned = 0;
for (const root of roots) {
  try {
    if (!statSync(root).isDirectory()) continue;
  } catch {
    continue;
  }
  walk(root);
  scanned += 1;
}

console.log(`Normalized relative ESM imports in ${scanned} dist directories.`);
