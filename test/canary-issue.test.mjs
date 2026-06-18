import test from "node:test";
import assert from "node:assert/strict";

import {
  issueBodyForFailure,
  issueTitleForFailure,
  logExcerpt,
  workflowFallbackFailure
} from "../scripts/lib/canary-issue.mjs";

const failure = {
  channel: "prod",
  phase: "build",
  failingName: "open-target-dispatcher",
  upstreamVersion: "26.616.30709",
  upstreamBuildNumber: "30709",
  packageVersion: "26.616.30709-launcher.29",
  fingerprint: "prod:open-target-dispatcher:26.616.30709:30709",
  errorMessage: "open-target-dispatcher contract changed: missing runner",
  localReproductionCommand: "node scripts/canary.mjs --channel prod --json-output dist/upstream-canary-prod.json",
  codePaths: ["scripts/lib/upstream-patches.mjs"],
  publishBlockedBeforeMutation: true
};

test("canary issue title uses stable dedupe fields", () => {
  assert.equal(
    issueTitleForFailure(failure),
    "Upstream canary failed: prod open-target-dispatcher 26.616.30709"
  );
});

test("canary issue body includes actionable repair evidence", () => {
  const body = issueBodyForFailure({
    failure,
    workflowUrl: "https://github.com/better-slop/codex-app-linux/actions/runs/1",
    jobName: "upstream-canary",
    stepName: "Run upstream canary",
    logExcerpt: "stack line"
  });

  assert.match(body, /Workflow run/);
  assert.match(body, /Channel \| prod/);
  assert.match(body, /Upstream build \| 30709/);
  assert.match(body, /Package version \| 26\.616\.30709-launcher\.29/);
  assert.match(body, /Contract\/smoke \| open-target-dispatcher/);
  assert.match(body, /Publish blocked before mutation \| yes/);
  assert.match(body, /missing runner/);
  assert.match(body, /stack line/);
  assert.match(body, /node scripts\/canary\.mjs --channel prod/);
  assert.match(body, /scripts\/lib\/upstream-patches\.mjs/);
});

test("logExcerpt keeps the tail of long logs", () => {
  const text = Array.from({ length: 130 }, (_, index) => `line-${index}`).join("\n");
  const excerpt = logExcerpt(text, 5);

  assert.equal(excerpt, ["line-125", "line-126", "line-127", "line-128", "line-129"].join("\n"));
});

test("workflowFallbackFailure files an issue when canary summary is missing", () => {
  const fallback = workflowFallbackFailure({
    workflowUrl: "https://github.com/better-slop/codex-app-linux/actions/runs/1",
    errorMessage: "ENOENT dist/upstream-canary.json"
  });

  assert.equal(issueTitleForFailure(fallback), "Upstream canary failed: unknown workflow-failure unknown");
  assert.equal(fallback.publishBlockedBeforeMutation, true);
  assert.match(fallback.localReproductionCommand, /gh run view/);
  assert.match(fallback.errorMessage, /ENOENT/);
  assert.deepEqual(
    fallback.codePaths,
    [
      ".github/workflows/upstream-canary.yml",
      ".github/workflows/release.yml",
      "scripts/canary.mjs",
      "scripts/report-canary-failure.mjs"
    ]
  );
});
