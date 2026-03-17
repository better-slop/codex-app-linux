import path from "node:path";
import process from "node:process";

import { fetchAppcastMetadata } from "./lib/appcast.mjs";
import { buildChannel, npmVersionExists, publishPackage } from "./lib/build.mjs";
import { defaultAppCommand, defaultPackageName, getChannel, parseArgs } from "./lib/config.mjs";

const args = parseArgs(process.argv.slice(2));
const channelName = String(args.channel || "");

if (!channelName) {
  throw new Error("--channel is required");
}

const channel = getChannel(channelName);
const packageName = String(args["package-name"] || defaultPackageName);
const appCommand = String(args["app-command"] || defaultAppCommand);
const archiveOverride = args.archive ? path.resolve(String(args.archive)) : null;
const publish = Boolean(args.publish);
const force = Boolean(args.force);

const upstream = await fetchAppcastMetadata(channel.appcastUrl);
const packageVersion =
  channel.name === "prod"
    ? upstream.version
    : `${upstream.version}-beta.${upstream.buildNumber}`;

if (!force && !archiveOverride) {
  const alreadyPublished = await npmVersionExists(packageName, packageVersion);

  if (alreadyPublished) {
    console.log(
      JSON.stringify(
        {
          channel: channel.name,
          packageName,
          packageVersion,
          skipped: true,
          reason: "already-published"
        },
        null,
        2
      )
    );
    process.exit(0);
  }
}

const result = await buildChannel({
  channel,
  upstream,
  packageName,
  appCommand,
  archiveOverride
});

if (publish) {
  await publishPackage(result.packageDir, channel.distTag);
}

console.log(
  JSON.stringify(
    {
      channel: channel.name,
      packageName,
      packageVersion: result.npmVersion,
      archivePath: result.archivePath,
      packageDir: result.packageDir,
      published: publish
    },
    null,
    2
  )
);
