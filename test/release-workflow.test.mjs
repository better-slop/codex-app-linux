import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("release workflow refuses existing npm versions before clobbering release assets", async () => {
  const workflow = await fs.readFile(".github/workflows/release.yml", "utf8");
  const guard = "Refuse immutable npm version overwrite";
  const prodGuard = workflow.indexOf(guard);
  const betaGuard = workflow.indexOf(guard, prodGuard + guard.length);
  const prodUpload = workflow.indexOf("gh release upload", prodGuard);
  const betaUpload = workflow.indexOf("gh release upload", betaGuard);

  assert.notEqual(prodGuard, -1);
  assert.notEqual(betaGuard, -1);
  assert.match(workflow, /npm package version already exists; refusing to clobber/);
  assert.ok(prodGuard < prodUpload);
  assert.ok(betaGuard < betaUpload);
});
