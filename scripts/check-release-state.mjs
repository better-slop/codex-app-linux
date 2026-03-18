import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { fetchAppcastMetadata } from "./lib/appcast.mjs";
import {
  defaultPackageName,
  getChannel,
  npmVersionFor,
  parseArgs
} from "./lib/config.mjs";
import { summarizeChannelReleaseState } from "./lib/release-state.mjs";

const args = parseArgs(process.argv.slice(2));
const packageName = String(args["package-name"] || defaultPackageName);
const jsonOutputPath = args["json-output"]
  ? path.resolve(String(args["json-output"]))
  : null;
const force = String(args.force || "false") === "true";

const [prod, beta] = await Promise.all([
  resolveChannelState("prod", packageName),
  resolveChannelState("beta", packageName)
]);

const summary = {
  packageName,
  force,
  channels: {
    prod,
    beta
  }
};

for (const channelState of [prod, beta]) {
  if (!channelState.outdated && !force) {
    console.log(
      `::warning::${channelState.channel} already published at ${channelState.packageVersion}; skipping unless force=true`
    );
  }
}

if (jsonOutputPath) {
  await fs.mkdir(path.dirname(jsonOutputPath), { recursive: true });
  await fs.writeFile(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(JSON.stringify(summary, null, 2));

async function resolveChannelState(channelName, packageName) {
  const channel = getChannel(channelName);
  const upstream = await fetchAppcastMetadata(channel.appcastUrl);
  const packageVersion = npmVersionFor(channel.name, upstream);
  const publishedVersion = await lookupPublishedVersion(packageName, packageVersion);

  return summarizeChannelReleaseState({
    channel,
    packageVersion,
    publishedVersion
  });
}

async function lookupPublishedVersion(packageName, packageVersion) {
  try {
    const output = await run(
      ["npm", "view", `${packageName}@${packageVersion}`, "version", "--json"],
      { capture: true }
    );
    const trimmed = output.trim();

    if (!trimmed) {
      return null;
    }

    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function run(command, options = {}) {
  const { capture = false } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`Command failed (${command.join(" ")}): ${code}\n${stderr}`));
    });
  });
}
