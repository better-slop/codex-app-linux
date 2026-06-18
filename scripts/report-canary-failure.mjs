import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { parseArgs } from "./lib/config.mjs";
import {
  canaryIssueLabels,
  issueBodyForFailure,
  issueTitleForFailure,
  logExcerpt,
  workflowFallbackFailure
} from "./lib/canary-issue.mjs";

const args = parseArgs(process.argv.slice(2));
const summaryPath = args.summary ? path.resolve(String(args.summary)) : null;
const logPath = args.log ? path.resolve(String(args.log)) : null;
const repo = String(args.repo || process.env.GITHUB_REPOSITORY || "");
const workflowUrl = String(args["workflow-url"] || defaultWorkflowUrl());
const jobName = String(args["job-name"] || process.env.GITHUB_JOB || "");
const stepName = String(args["step-name"] || "");

if (!repo) {
  throw new Error("--repo or GITHUB_REPOSITORY is required");
}

const logText = logPath ? await fs.readFile(logPath, "utf8").catch(() => "") : "";
const summaryResult = await readSummary(summaryPath);
const failures = summaryResult.ok && Array.isArray(summaryResult.summary.failures)
  ? summaryResult.summary.failures
  : [
      workflowFallbackFailure({
        workflowUrl,
        errorMessage: summaryResult.errorMessage
      })
    ];

if (failures.length === 0) {
  process.stdout.write("No canary failures found; no issue written.\n");
  process.exit(0);
}

async function readSummary(filePath) {
  if (!filePath) {
    return {
      ok: false,
      errorMessage: "--summary was not provided"
    };
  }

  try {
    return {
      ok: true,
      summary: JSON.parse(await fs.readFile(filePath, "utf8"))
    };
  } catch (error) {
    return {
      ok: false,
      errorMessage: `Canary failed before writing a structured summary: ${error.message}`
    };
  }
}

const availableLabels = await listAvailableLabels(repo);
const labels = canaryIssueLabels.filter(label => availableLabels.has(label));
const openIssues = await listOpenIssues(repo);

for (const failure of failures) {
  const title = issueTitleForFailure(failure);
  const body = issueBodyForFailure({
    failure,
    workflowUrl,
    jobName,
    stepName,
    logExcerpt: logExcerpt(logText)
  });
  const existing = openIssues.find(issue => issue.title === title);

  if (existing) {
    await updateIssue(repo, existing.number, body, labels);
    process.stdout.write(`Updated issue #${existing.number}: ${title}\n`);
  } else {
    const issue = await createIssue(repo, title, body, labels);
    process.stdout.write(`Created issue #${issue.number}: ${title}\n`);
  }
}

async function listAvailableLabels(repo) {
  const output = await gh(["label", "list", "--repo", repo, "--json", "name", "--limit", "200"], {
    capture: true
  }).catch(() => "[]");
  const labels = JSON.parse(output);

  return new Set(labels.map(label => label.name));
}

async function listOpenIssues(repo) {
  const output = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title",
    "--limit",
    "200"
  ], {
    capture: true
  });

  return JSON.parse(output);
}

async function createIssue(repo, title, body, labels) {
  const bodyFile = await writeTempBody(body);
  const command = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body-file",
    bodyFile
  ];

  if (labels.length > 0) {
    command.push("--label", labels.join(","));
  }

  const output = await gh(command, { capture: true });
  const number = Number(output.trim().match(/\/issues\/(\d+)$/)?.[1] || 0);

  return {
    number,
    title
  };
}

async function updateIssue(repo, number, body, labels) {
  const bodyFile = await writeTempBody(body);
  const command = [
    "issue",
    "edit",
    String(number),
    "--repo",
    repo,
    "--body-file",
    bodyFile
  ];

  if (labels.length > 0) {
    command.push("--add-label", labels.join(","));
  }

  await gh(command);
}

async function writeTempBody(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-canary-issue-"));
  const filePath = path.join(dir, "body.md");

  await fs.writeFile(filePath, body);
  return filePath;
}

function gh(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ""
      }
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`gh ${args.join(" ")} failed with ${code}\n${stderr}`));
    });
  });
}

function defaultWorkflowUrl() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }

  return "";
}
