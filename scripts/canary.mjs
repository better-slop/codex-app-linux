import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { fetchAppcastMetadata } from "./lib/appcast.mjs";
import { buildChannel } from "./lib/build.mjs";
import {
  defaultLauncherCommand,
  defaultPackageName,
  defaultReleaseRepo,
  getChannel,
  npmVersionFor,
  parseArgs
} from "./lib/config.mjs";
import { smokeLinuxArtifacts } from "./smoke-artifacts.mjs";

const args = parseArgs(process.argv.slice(2));
const channelNames = parseChannels(args.channel);
const packageName = String(args["package-name"] || defaultPackageName);
const launcherCommand = String(args["app-command"] || defaultLauncherCommand);
const releaseRepo = String(args["release-repo"] || defaultReleaseRepo);
const jsonOutputPath = args["json-output"]
  ? path.resolve(String(args["json-output"]))
  : null;
const runSmoke = args["no-smoke"] !== true;
const runBrowser = args["no-browser"] !== true;
const summary = {
  ok: true,
  packageName,
  releaseRepo,
  publishBlockedBeforeMutation: true,
  startedAt: new Date().toISOString(),
  channels: {},
  failures: []
};

for (const channelName of channelNames) {
  const channel = getChannel(channelName);
  let upstream = null;
  let packageVersion = null;
  let phase = "fetch-appcast";

  try {
    upstream = await fetchAppcastMetadata(channel.appcastUrl);
    packageVersion = npmVersionFor(channel.name, upstream);
    phase = "build";

    const build = await buildChannel({
      channel,
      upstream,
      packageName,
      launcherCommand,
      releaseRepo
    });

    phase = "smoke";
    const smoke = runSmoke
      ? await smokeLinuxArtifacts({
          channelName: channel.name,
          linuxDir: build.linuxDir,
          packageDir: build.packageDir,
          browser: runBrowser
        })
      : null;

    summary.channels[channel.name] = {
      ok: true,
      upstream,
      packageVersion,
      linuxDir: build.linuxDir,
      packageDir: build.packageDir,
      releaseTag: build.releaseTag,
      smoke
    };
  } catch (error) {
    const failure = normalizeCanaryFailure({
      channel,
      upstream,
      packageVersion,
      phase,
      error
    });

    summary.ok = false;
    summary.channels[channel.name] = {
      ok: false,
      upstream,
      packageVersion,
      failure
    };
    summary.failures.push(failure);
  } finally {
    if (jsonOutputPath) {
      await writeJson(jsonOutputPath, summary);
    }
  }
}

summary.finishedAt = new Date().toISOString();

if (jsonOutputPath) {
  await writeJson(jsonOutputPath, summary);
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (!summary.ok) {
  process.exitCode = 1;
}

export function normalizeCanaryFailure({ channel, upstream, packageVersion, phase, error }) {
  const message = toErrorMessage(error);
  const failingName = failingContractOrSmokeName(error, message, phase);

  return {
    channel: channel.name,
    phase,
    failingName,
    upstreamVersion: upstream?.version || "unknown",
    upstreamBuildNumber: upstream?.buildNumber || "unknown",
    packageVersion: packageVersion || "unknown",
    fingerprint: `${channel.name}:${failingName}:${upstream?.version || "unknown"}:${upstream?.buildNumber || "unknown"}`,
    errorMessage: message,
    localReproductionCommand: `node scripts/canary.mjs --channel ${channel.name} --json-output dist/upstream-canary-${channel.name}.json`,
    codePaths: codePathsForFailure(failingName, phase),
    publishBlockedBeforeMutation: true
  };
}

function parseChannels(value) {
  if (!value) {
    return ["prod", "beta"];
  }

  return String(value)
    .split(",")
    .map(channel => channel.trim())
    .filter(Boolean);
}

function failingContractOrSmokeName(error, message, phase) {
  if (error?.contractName) {
    return error.contractName;
  }

  const smokeMatch = message.match(/^([a-z0-9_-]+) smoke failed:/i);
  if (smokeMatch) {
    return smokeMatch[1];
  }

  const contractMatch = message.match(/^([a-z0-9_-]+) contract changed:/i);
  if (contractMatch) {
    return contractMatch[1];
  }

  return phase;
}

function codePathsForFailure(name, phase) {
  if (name.includes("open-target") || name.includes("window")) {
    return ["scripts/lib/upstream-patches.mjs", "test/upstream-patches.test.mjs"];
  }

  if (name.includes("web")) {
    return ["scripts/smoke-artifacts.mjs", "runtime/webstrap/server.mjs", "runtime/webstrap/message-router.mjs"];
  }

  if (name.includes("node_repl") || name.includes("native") || name.includes("desktop")) {
    return ["scripts/smoke-artifacts.mjs", "scripts/lib/build.mjs", "runtime/launcher.mjs"];
  }

  if (phase === "build") {
    return ["scripts/lib/build.mjs", "scripts/lib/upstream-patches.mjs"];
  }

  return ["scripts/canary.mjs"];
}

async function writeJson(filePath, body) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
