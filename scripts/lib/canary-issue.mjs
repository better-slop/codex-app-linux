export const canaryIssueLabels = ["upstream-canary", "release-blocker", "automated"];

export function issueTitleForFailure(failure) {
  return `Upstream canary failed: ${failure.channel} ${failure.failingName} ${failure.upstreamVersion}`;
}

export function issueBodyForFailure({
  failure,
  workflowUrl,
  jobName,
  stepName,
  logExcerpt
}) {
  const codePaths = Array.isArray(failure.codePaths) && failure.codePaths.length > 0
    ? failure.codePaths.map(file => `- \`${file}\``).join("\n")
    : "- unknown";

  return [
    "Automated upstream canary failure.",
    "",
    `Fingerprint: \`${failure.fingerprint}\``,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Workflow run | ${workflowUrl || "unknown"} |`,
    `| Failing job | ${jobName || "unknown"} |`,
    `| Failing step | ${stepName || failure.phase || "unknown"} |`,
    `| Channel | ${failure.channel} |`,
    `| Upstream version | ${failure.upstreamVersion} |`,
    `| Upstream build | ${failure.upstreamBuildNumber} |`,
    `| Package version | ${failure.packageVersion} |`,
    `| Contract/smoke | ${failure.failingName} |`,
    `| Publish blocked before mutation | ${failure.publishBlockedBeforeMutation ? "yes" : "unknown"} |`,
    "",
    "Exact error:",
    "",
    "```text",
    failure.errorMessage || "unknown",
    "```",
    "",
    "Relevant log excerpt:",
    "",
    "```text",
    logExcerpt || "No log excerpt captured.",
    "```",
    "",
    "Local reproduction:",
    "",
    "```bash",
    failure.localReproductionCommand || `node scripts/canary.mjs --channel ${failure.channel}`,
    "```",
    "",
    "Likely code paths:",
    "",
    codePaths
  ].join("\n");
}

export function workflowFallbackFailure({
  errorMessage,
  localReproductionCommand = "node scripts/canary.mjs",
  workflowUrl = ""
} = {}) {
  return {
    channel: "unknown",
    phase: "workflow",
    failingName: "workflow-failure",
    upstreamVersion: "unknown",
    upstreamBuildNumber: "unknown",
    packageVersion: "unknown",
    fingerprint: "unknown:workflow-failure:unknown:unknown",
    errorMessage: errorMessage || "Canary failed before writing a structured summary. Inspect the workflow log.",
    localReproductionCommand: workflowUrl ? `gh run view ${workflowUrl} --log` : localReproductionCommand,
    codePaths: [
      ".github/workflows/upstream-canary.yml",
      ".github/workflows/release.yml",
      "scripts/canary.mjs",
      "scripts/report-canary-failure.mjs"
    ],
    publishBlockedBeforeMutation: true
  };
}

export function logExcerpt(logText, maxLines = 120) {
  const lines = String(logText || "")
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);

  return lines.slice(-maxLines).join("\n").slice(-12_000);
}
