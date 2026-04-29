const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") {
    return;
  }

  await copyExtraResources(context.appOutDir);

  const executableName =
    process.env.CODEX_APP_EXECUTABLE_NAME ||
    context.packager.executableName ||
    context.packager.appInfo.productFilename;
  const launcherPath = path.join(context.appOutDir, executableName);
  const binaryPath = path.join(context.appOutDir, `${executableName}-bin`);

  if (await isWrappedLauncher(launcherPath, binaryPath)) {
    await ensureCodexCompatibilitySymlink(context.appOutDir, path.basename(binaryPath));
    return;
  }

  await fs.rm(binaryPath, { force: true });
  await fs.rename(launcherPath, binaryPath);
  await fs.writeFile(launcherPath, wrapperScript(path.basename(binaryPath)), {
    mode: 0o755
  });
  await ensureCodexCompatibilitySymlink(context.appOutDir, path.basename(binaryPath));
};

async function copyExtraResources(appOutDir) {
  const extraResourcesDir = process.env.CODEX_STAGE_RESOURCES_DIR;

  if (!extraResourcesDir) {
    return;
  }

  const resourcesDir = path.join(appOutDir, "resources");
  const entries = await fs.readdir(extraResourcesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "app.asar" || entry.name === "app.asar.unpacked") {
      continue;
    }

    const sourcePath = path.join(extraResourcesDir, entry.name);
    const targetPath = path.join(resourcesDir, entry.name);
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(sourcePath, targetPath, { recursive: true });
  }
}

module.exports.copyExtraResources = copyExtraResources;

async function ensureCodexCompatibilitySymlink(appOutDir, binaryName) {
  const linkPath = path.join(appOutDir, "codex");

  await fs.rm(linkPath, { force: true });
  await fs.symlink(binaryName, linkPath);
}

module.exports.ensureCodexCompatibilitySymlink = ensureCodexCompatibilitySymlink;

async function isWrappedLauncher(launcherPath, binaryPath) {
  try {
    await fs.access(binaryPath);
  } catch {
    return false;
  }

  try {
    const content = await fs.readFile(launcherPath, "utf8");
    return (
      content.includes("CODEX_CLI_PATH") &&
      content.includes(path.basename(binaryPath))
    );
  } catch {
    return false;
  }
}

function wrapperScript(binaryName) {
  return `#!/bin/sh
set -eu

resolve_codex() {
  if [ -n "\${CODEX_CLI_PATH:-}" ] && [ -x "\${CODEX_CLI_PATH}" ]; then
    printf '%s\\n' "\${CODEX_CLI_PATH}"
    return 0
  fi

  candidate="$(command -v codex 2>/dev/null || true)"

  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\\n' "$candidate"
    return 0
  fi

  return 1
}

if ! resolved_codex="$(resolve_codex)"; then
  echo "Unable to locate the Codex CLI binary. Set CODEX_CLI_PATH or install 'codex' on PATH." >&2
  exit 1
fi

export CODEX_CLI_PATH="$resolved_codex"

script_path="$0"

if command -v readlink >/dev/null 2>&1; then
  resolved_script="$(readlink -f -- "$script_path" 2>/dev/null || true)"

  if [ -n "$resolved_script" ]; then
    script_path="$resolved_script"
  fi
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)"
exec "$script_dir/${binaryName}" "$@"
`;
}

module.exports.wrapperScript = wrapperScript;
