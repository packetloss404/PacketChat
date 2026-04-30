import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));

test("refresh token rotation locks the token row before minting a child token", async () => {
  const source = await readFile(join(testDir, "../src/index.ts"), "utf8");
  const rotationStart = source.indexOf("export async function rotateRefreshToken");
  const rotationEnd = source.indexOf("export async function revokeSession", rotationStart);
  const rotationSource = source.slice(rotationStart, rotationEnd);

  assert.match(rotationSource, /sql\.begin\(async \(tx\)/);
  assert.match(rotationSource, /for update of rt/i);
  assert.match(rotationSource, /update refresh_tokens set used_at = now\(\), revoked_at = now\(\) where id = \$\{existing\.id\}/);
  assert.ok(
    rotationSource.indexOf("for update of rt") < rotationSource.indexOf("insert into refresh_tokens"),
    "the existing token row must be locked before inserting the replacement token"
  );
});
