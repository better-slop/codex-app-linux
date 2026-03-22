import path from "node:path";
import process from "node:process";

export const projectRoot = process.cwd();
export const distRoot = path.join(projectRoot, "dist");
export const stageRoot = path.join(projectRoot, "stage");
export const cacheRoot = path.join(projectRoot, ".cache");
export const defaultPackageName =
  process.env.NPM_PACKAGE_NAME || "codex-app-linux";
export const defaultLauncherCommand =
  process.env.CODEX_APP_COMMAND || "codex-app-linux";
export const defaultReleaseRepo =
  process.env.CODEX_RELEASE_REPO || "cau1k/codex-app-linux";
export const defaultPackageRevision = Number(
  process.env.CODEX_PACKAGE_REVISION || "2"
);

export const channels = {
  prod: {
    appcastUrl: "https://persistent.oaistatic.com/codex-app-prod/appcast.xml",
    distTag: "latest",
    displayName: "Codex",
    appId: "com.openai.codex.linux",
    executableName: "codex-app-linux",
    aurPackageName: "codex-app-linux-bin",
    prerelease: false
  },
  beta: {
    appcastUrl: "https://persistent.oaistatic.com/codex-app-beta/appcast.xml",
    distTag: "beta",
    displayName: "Codex Beta",
    appId: "com.openai.codex.beta.linux",
    executableName: "codex-app-linux-beta",
    aurPackageName: "codex-app-linux-beta-bin",
    prerelease: true
  }
};

export function getChannel(name) {
  const channel = channels[name];

  if (!channel) {
    throw new Error(`Unknown channel: ${name}`);
  }

  return { name, ...channel };
}

export function npmVersionFor(
  channelName,
  upstream,
  packageRevision = defaultPackageRevision
) {
  const baseVersion =
    channelName === "prod"
      ? upstream.version
      : `${upstream.version}-beta.${upstream.buildNumber}`;

  if (!Number.isInteger(packageRevision) || packageRevision < 0) {
    throw new Error(`Invalid CODEX_PACKAGE_REVISION: ${packageRevision}`);
  }

  if (packageRevision === 0) {
    return baseVersion;
  }

  if (channelName === "prod") {
    return `${baseVersion}-launcher.${packageRevision}`;
  }

  return `${baseVersion}.launcher.${packageRevision}`;
}

export function releaseTagForVersion(version) {
  return `v${version}`;
}

export function assetBaseName(packageName, version) {
  return `${packageName}-${version}-x64`;
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
