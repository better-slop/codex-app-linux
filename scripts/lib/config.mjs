import path from "node:path";
import process from "node:process";

export const projectRoot = process.cwd();
export const distRoot = path.join(projectRoot, "dist");
export const stageRoot = path.join(projectRoot, "stage");
export const cacheRoot = path.join(projectRoot, ".cache");
export const defaultPackageName =
  process.env.NPM_PACKAGE_NAME || "@cau1k/codex-app-linux";
export const defaultAppCommand =
  process.env.CODEX_APP_COMMAND || "codex-desktop";

export const channels = {
  prod: {
    appcastUrl: "https://persistent.oaistatic.com/codex-app-prod/appcast.xml",
    distTag: "latest",
    displayName: "Codex"
  },
  beta: {
    appcastUrl: "https://persistent.oaistatic.com/codex-app-beta/appcast.xml",
    distTag: "beta",
    displayName: "Codex Beta"
  }
};

export function getChannel(name) {
  const channel = channels[name];

  if (!channel) {
    throw new Error(`Unknown channel: ${name}`);
  }

  return { name, ...channel };
}

export function npmVersionFor(channelName, upstream) {
  if (channelName === "prod") {
    return upstream.version;
  }

  return `${upstream.version}-beta.${upstream.buildNumber}`;
}

export function channelPaths(channelName) {
  return {
    cacheDir: path.join(cacheRoot, channelName),
    stageDir: path.join(stageRoot, channelName),
    stageAppDir: path.join(stageRoot, channelName, "app"),
    stageArchiveDir: path.join(stageRoot, channelName, "archive"),
    outputDir: path.join(distRoot, channelName),
    npmDir: path.join(distRoot, "npm", channelName)
  };
}

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}
