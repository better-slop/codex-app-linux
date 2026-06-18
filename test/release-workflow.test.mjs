import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

test("release workflow runs canary and smoke before publish mutations", async () => {
  const workflow = await fs.readFile(".github/workflows/release.yml", "utf8");
  const canaryJob = workflow.indexOf("  canary:");
  const publishProd = workflow.indexOf("  publish-prod:");
  const publishBeta = workflow.indexOf("  publish-beta:");
  const prodSmoke = workflow.indexOf("Smoke channel", publishProd);
  const betaSmoke = workflow.indexOf("Smoke channel", publishBeta);
  const prodRelease = workflow.indexOf("Create or update GitHub release", publishProd);
  const betaRelease = workflow.indexOf("Create or update GitHub release", publishBeta);

  assert.ok(canaryJob > 0);
  assert.ok(canaryJob < publishProd);
  assert.ok(canaryJob < publishBeta);
  assert.match(workflow, /publish-prod:\n\s+needs: \[preflight, canary\]/);
  assert.match(workflow, /publish-beta:\n\s+needs: \[preflight, canary\]/);
  assert.ok(prodSmoke < prodRelease);
  assert.ok(betaSmoke < betaRelease);
});

test("upstream canary workflow reports scheduled failures without publish permissions", async () => {
  const workflow = await fs.readFile(".github/workflows/upstream-canary.yml", "utf8");
  const canaryJob = workflow.slice(
    workflow.indexOf("  upstream-canary:"),
    workflow.indexOf("  report-scheduled-failure:")
  );

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(canaryJob, /issues: write/);
  assert.doesNotMatch(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /npm publish|gh release upload|aur\.archlinux/);
  assert.match(workflow, /node scripts\/report-canary-failure\.mjs/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
});

test("release-channel CLI refuses direct publish bypass", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/release-channel.mjs", "--channel", "prod", "--publish"]),
    error => {
      assert.match(error.stderr, /--publish is disabled/);
      return true;
    }
  );
});
