import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(output || `${command} ${args.join(" ")} failed with ${result.status}`);
  }
  return result.stdout;
}

const trackedFiles = run("git", ["ls-files", "*.js", "*.mjs"])
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean)
  .filter((file) => !file.includes("/node_modules/") && !file.includes("/.next/") && !file.includes("/dist/"));

for (const file of trackedFiles) {
  run(process.execPath, ["--check", file]);
}

console.log(`JS syntax ok (${trackedFiles.length} files)`);
