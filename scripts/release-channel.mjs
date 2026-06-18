import path from "node:path";
import process from "node:process";
import fs from "node:fs/promises";

import { fetchAppcastMetadata } from "./lib/appcast.mjs";
import { buildChannel, npmVersionExists } from "./lib/build.mjs";
import {
  defaultLauncherCommand,
  defaultPackageName,
  defaultReleaseRepo,
  getChannel,
  npmVersionFor,
  parseArgs
} from "./lib/config.mjs";

const args = parseArgs(process.argv.slice(2));
const channelName = String(args.channel || "");

if (!channelName) {
  throw new Error("--channel is required");
}

const channel = getChannel(channelName);
const packageName = String(args["package-name"] || defaultPackageName);
const launcherCommand = String(args["app-command"] || defaultLauncherCommand);
const releaseRepo = String(args["release-repo"] || defaultReleaseRepo);
const archiveOverride = args.archive ? path.resolve(String(args.archive)) : null;
const publish = Boolean(args.publish);
const force = Boolean(args.force);
const jsonOutputPath = args["json-output"]
  ? path.resolve(String(args["json-output"]))
  : null;

if (publish) {
  throw new Error("--publish is disabled; use the release workflow so canary and smoke gates run before publish");
}

const upstream = await fetchAppcastMetadata(channel.appcastUrl);
const packageVersion = npmVersionFor(channel.name, upstream);

if (!force && !archiveOverride) {
  const alreadyPublished = await npmVersionExists(packageName, packageVersion);

  if (alreadyPublished) {
    const summary = {
      channel: channel.name,
      packageName,
      packageVersion,
      skipped: true,
      reason: "already-published"
    };

    if (jsonOutputPath) {
      await fs.mkdir(path.dirname(jsonOutputPath), { recursive: true });
      await fs.writeFile(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);
    }

    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }
}

const result = await buildChannel({
  channel,
  upstream,
  packageName,
  launcherCommand,
  releaseRepo,
  archiveOverride
});

const summary = {
  channel: channel.name,
  packageName,
  packageVersion: result.npmVersion,
  archivePath: result.archivePath,
  linuxDir: result.linuxDir,
  packageDir: result.packageDir,
  appImagePath: result.appImagePath,
  unpackedTarballPath: result.unpackedTarballPath,
  iconAssetPath: result.iconAssetPath,
  checksumsPath: result.checksumsPath,
  aurDir: result.aurDir,
  aurPackage: result.aurPackage,
  releaseRepo: result.releaseRepo,
  releaseTag: result.releaseTag,
  prerelease: channel.prerelease,
  published: false
};

if (jsonOutputPath) {
  await fs.mkdir(path.dirname(jsonOutputPath), { recursive: true });
  await fs.writeFile(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(JSON.stringify(summary, null, 2));
