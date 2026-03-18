import process from "node:process";

import { getChannel, parseArgs } from "./lib/config.mjs";

const args = parseArgs(process.argv.slice(2));
const channel = getChannel(String(args.channel || ""));
const packageVersion = String(args["package-version"] || "");
const aurPackageName = String(args["aur-package-name"] || channel.aurPackageName || "");

if (!channel.name) {
  throw new Error("--channel is required");
}

if (!packageVersion) {
  throw new Error("--package-version is required");
}

const lines = [
  `Automated Linux release for ${channel.name}.`,
  "",
  "## Install",
  "",
  "npm:",
  "```bash",
  channel.distTag === "latest"
    ? "npm i -g codex-app-linux"
    : "npm i -g codex-app-linux@beta",
  channel.distTag === "latest" ? "npx codex-app-linux" : "npx codex-app-linux@beta",
  "```"
];

if (aurPackageName) {
  lines.push(
    "",
    "AUR:",
    `- https://aur.archlinux.org/packages/${aurPackageName}`
  );
}

lines.push(
  "",
  "Version:",
  `- npm package: \`${packageVersion}\``
);

console.log(lines.join("\n"));
