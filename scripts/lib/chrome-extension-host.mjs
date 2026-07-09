import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { cacheRoot, projectRoot } from "./config.mjs";
import {
  CHROME_EXTENSION_HOST_ARCH,
  CHROME_EXTENSION_HOST_CONTENT_VARIANT,
  CHROME_EXTENSION_HOST_TARGET
} from "./chrome-extension-constants.mjs";

const execFileAsync = promisify(execFile);
const crateDir = path.join(projectRoot, "native", "chrome-extension-host");
const defaultCargoTargetDir = path.join(cacheRoot, "chrome-extension-host-target");
const defaultLicensePath = path.join(crateDir, "LICENSES", "ilysenko-MIT.txt");
const defaultNoticesPath = path.join(crateDir, "THIRD_PARTY_NOTICES.md");

export { CHROME_EXTENSION_HOST_CONTENT_VARIANT };

/** Build the vendored host as a static musl executable and verify the result. */
export async function buildLinuxChromeExtensionHost({
  cargoTargetDir = defaultCargoTargetDir
} = {}) {
  const manifestPath = path.join(crateDir, "Cargo.toml");

  await execFileAsync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      manifestPath,
      "--target",
      CHROME_EXTENSION_HOST_TARGET
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: cargoTargetDir
      },
      maxBuffer: 16 * 1024 * 1024
    }
  );

  const binaryPath = path.join(
    cargoTargetDir,
    CHROME_EXTENSION_HOST_TARGET,
    "release",
    "codex-chrome-extension-host"
  );
  await assertStaticLinuxChromeExtensionHost(binaryPath);
  return binaryPath;
}

/**
 * Replace any upstream host with the audited project build. Upstream has
 * alternated between an empty directory and Darwin-only payloads, so the
 * Linux artifact is always authoritative.
 */
export async function stageLinuxChromeExtensionHost(
  resourcesDir,
  {
    sourcePath,
    licensePath = defaultLicensePath,
    noticesPath = defaultNoticesPath
  } = {}
) {
  const pluginRoot = chromePluginRoot(resourcesDir);

  if (!(await isDirectory(pluginRoot))) {
    throw new Error(`Chrome plugin root is missing: ${pluginRoot}`);
  }

  const hostSource = sourcePath || (await buildLinuxChromeExtensionHost());
  const targetPath = path.join(
    pluginRoot,
    "extension-host",
    "linux",
    CHROME_EXTENSION_HOST_ARCH,
    "extension-host"
  );
  const temporaryPath = `${targetPath}.installing-${process.pid}`;
  const targetLicensePath = path.join(
    pluginRoot,
    "extension-host",
    "linux",
    "LICENSE.ilysenko-MIT.txt"
  );
  const targetNoticesPath = path.join(
    pluginRoot,
    "extension-host",
    "linux",
    "THIRD_PARTY_NOTICES.md"
  );

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(licensePath, targetLicensePath);
  await fs.copyFile(noticesPath, targetNoticesPath);
  try {
    await fs.copyFile(hostSource, temporaryPath);
    await fs.chmod(temporaryPath, 0o755);
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }

  return targetPath;
}

export async function assertStaticLinuxChromeExtensionHost(binaryPath) {
  const { stdout } = await execFileAsync("file", ["-b", binaryPath]);
  const fileType = stdout.trim();
  const staticExecutable = /\b(?:static-pie|statically) linked\b/i.test(fileType);

  if (!/\bELF\b/.test(fileType) || !/\bx86-64\b/.test(fileType) || !staticExecutable) {
    throw new Error(
      `Refusing non-static Linux x64 Chrome extension host ${binaryPath}: ${fileType}`
    );
  }

  return fileType;
}

export function chromePluginRoot(resourcesDir) {
  return path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome"
  );
}

async function isDirectory(targetPath) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
