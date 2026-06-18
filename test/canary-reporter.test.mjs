import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("report-canary-failure creates exactly one actionable GitHub issue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-canary-reporter-"));
  const callsPath = path.join(root, "gh-calls.jsonl");
  const fakeGhPath = await writeFakeGh(root, callsPath);
  const summaryPath = path.join(root, "summary.json");
  const logPath = path.join(root, "canary.log");

  await fs.writeFile(
    summaryPath,
    `${JSON.stringify({
      failures: [
        {
          channel: "prod",
          phase: "build",
          failingName: "open-target-dispatcher",
          upstreamVersion: "26.616.30709",
          upstreamBuildNumber: "4108",
          packageVersion: "26.616.30709-launcher.29",
          fingerprint: "prod:open-target-dispatcher:26.616.30709:4108",
          errorMessage: "open-target-dispatcher contract changed: missing runner",
          localReproductionCommand: "node scripts/canary.mjs --channel prod",
          codePaths: ["scripts/lib/upstream-patches.mjs"],
          publishBlockedBeforeMutation: true
        }
      ]
    })}\n`
  );
  await fs.writeFile(logPath, "canary log excerpt\n");

  await execFileAsync(process.execPath, [
    "scripts/report-canary-failure.mjs",
    "--summary",
    summaryPath,
    "--log",
    logPath,
    "--repo",
    "better-slop/codex-app-linux",
    "--workflow-url",
    "https://github.com/better-slop/codex-app-linux/actions/runs/1",
    "--job-name",
    "upstream-canary",
    "--step-name",
    "Run upstream canary"
  ], {
    env: {
      ...process.env,
      PATH: `${path.dirname(fakeGhPath)}:${process.env.PATH}`,
      FAKE_GH_CALLS: callsPath
    }
  });

  const calls = await readFakeGhCalls(callsPath);
  const issueMutations = calls.filter(args => args[0] === "issue" && ["create", "edit"].includes(args[1]));

  assert.equal(issueMutations.length, 1);
  assert.equal(issueMutations[0][1], "create");
  assert.match(issueMutations[0].join(" "), /Upstream canary failed: prod open-target-dispatcher 26\.616\.30709/);

  const body = await readBodyFileFromArgs(issueMutations[0]);
  assert.match(body, /Workflow run \| https:\/\/github\.com\/better-slop\/codex-app-linux\/actions\/runs\/1/);
  assert.match(body, /Failing job \| upstream-canary/);
  assert.match(body, /Failing step \| Run upstream canary/);
  assert.match(body, /Channel \| prod/);
  assert.match(body, /Upstream build \| 4108/);
  assert.match(body, /Package version \| 26\.616\.30709-launcher\.29/);
  assert.match(body, /open-target-dispatcher contract changed/);
  assert.match(body, /canary log excerpt/);
  assert.match(body, /scripts\/lib\/upstream-patches\.mjs/);
  assert.match(body, /Publish blocked before mutation \| yes/);
});

test("report-canary-failure updates exactly one existing GitHub issue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-canary-reporter-update-"));
  const callsPath = path.join(root, "gh-calls.jsonl");
  const fakeGhPath = await writeFakeGh(root, callsPath);
  const summaryPath = path.join(root, "summary.json");
  const title = "Upstream canary failed: unknown workflow-failure unknown";

  await fs.writeFile(summaryPath, "{}\n");

  await execFileAsync(process.execPath, [
    "scripts/report-canary-failure.mjs",
    "--summary",
    summaryPath,
    "--repo",
    "better-slop/codex-app-linux"
  ], {
    env: {
      ...process.env,
      PATH: `${path.dirname(fakeGhPath)}:${process.env.PATH}`,
      FAKE_GH_CALLS: callsPath,
      FAKE_GH_ISSUES: JSON.stringify([{ number: 77, title }])
    }
  });

  const calls = await readFakeGhCalls(callsPath);
  const issueMutations = calls.filter(args => args[0] === "issue" && ["create", "edit"].includes(args[1]));

  assert.equal(issueMutations.length, 1);
  assert.deepEqual(issueMutations[0].slice(0, 3), ["issue", "edit", "77"]);
});

async function writeFakeGh(root, callsPath) {
  const fakeGhPath = path.join(root, "gh");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "label" && args[1] === "list") {
  console.log(JSON.stringify([
    { name: "upstream-canary" },
    { name: "release-blocker" },
    { name: "automated" }
  ]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  console.log(process.env.FAKE_GH_ISSUES || "[]");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "create") {
  console.log("https://github.com/better-slop/codex-app-linux/issues/123");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  process.exit(0);
}
process.exit(0);
`;

  await fs.writeFile(fakeGhPath, script, { mode: 0o755 });
  await fs.writeFile(callsPath, "");
  return fakeGhPath;
}

async function readFakeGhCalls(callsPath) {
  const text = await fs.readFile(callsPath, "utf8");

  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function readBodyFileFromArgs(args) {
  const bodyFileIndex = args.indexOf("--body-file");

  assert.notEqual(bodyFileIndex, -1);
  return fs.readFile(args[bodyFileIndex + 1], "utf8");
}
