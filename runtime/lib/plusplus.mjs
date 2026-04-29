import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const plusplusCommands = new Set(["install", "status", "repair", "uninstall", "doctor"]);
const appAwareCommands = new Set(["install", "repair", "uninstall"]);

export function printPlusPlusUsage(stream = process.stdout) {
  stream.write(`Usage:\n`);
  stream.write(`  codex-app-linux --plusplus install [codexplusplus-options...]\n`);
  stream.write(`  codex-app-linux --plusplus status\n`);
  stream.write(`  codex-app-linux --plusplus repair [codexplusplus-options...]\n`);
  stream.write(`  codex-app-linux --plusplus uninstall [codexplusplus-options...]\n`);
  stream.write(`  codex-app-linux --plusplus doctor\n`);
}

export async function runCodexPlusPlus({ binaryPath, args, env = process.env }) {
  const command = args[0] || "install";

  if (command === "--help" || command === "-h" || command === "help") {
    printPlusPlusUsage();
    return 0;
  }

  if (!plusplusCommands.has(command)) {
    printPlusPlusUsage(process.stderr);
    throw new Error(`Unknown codex-plusplus command: ${command}`);
  }

  const appRoot = path.dirname(path.resolve(binaryPath));
  await ensureCodexCompatibilitySymlink(appRoot, binaryPath);

  const plusplus = await resolveCodexPlusPlusCommand({ env, bootstrap: command === "install" });
  const plusplusArgs = [command, ...args.slice(1)];

  if (appAwareCommands.has(command)) {
    plusplusArgs.push("--app", appRoot);
  }

  return await runCommand(plusplus.command, [...plusplus.args, ...plusplusArgs], { env });
}

export async function ensureCodexCompatibilitySymlink(appRoot, binaryPath) {
  const realBinaryPath = await resolveElectronBinaryPath(binaryPath);
  const targetName = path.basename(realBinaryPath);
  const linkPath = path.join(appRoot, "codex");

  await fsp.rm(linkPath, { force: true });
  await fsp.symlink(targetName, linkPath);

  return linkPath;
}

async function resolveElectronBinaryPath(binaryPath) {
  const resolved = path.resolve(binaryPath);
  const binaryName = path.basename(resolved);
  const siblingBinary = path.join(path.dirname(resolved), `${binaryName}-bin`);

  if (isExecutable(siblingBinary)) {
    return siblingBinary;
  }

  return resolved;
}

async function resolveCodexPlusPlusCommand({ env, bootstrap }) {
  if (env.CODEX_PLUSPLUS_CLI) {
    const cliPath = path.resolve(env.CODEX_PLUSPLUS_CLI);
    if (fs.existsSync(cliPath)) {
      return nodeCommand(cliPath);
    }
  }

  for (const command of ["codexplusplus", "codex-plusplus"]) {
    const resolved = which(command, env);
    if (resolved) {
      return { command: resolved, args: [] };
    }
  }

  const sourceRoot = path.resolve(
    env.CODEX_PLUSPLUS_SOURCE_DIR || path.join(os.homedir(), ".codex-plusplus", "source")
  );
  const sourceCli = path.join(sourceRoot, "packages", "installer", "dist", "cli.js");

  if (fs.existsSync(sourceCli)) {
    return nodeCommand(sourceCli);
  }

  if (!bootstrap) {
    throw new Error("codexplusplus is not installed. Run `codex-app-linux --plusplus install` first.");
  }

  await bootstrapCodexPlusPlusSource({ sourceRoot, env });

  if (!fs.existsSync(sourceCli)) {
    throw new Error(`codex-plusplus bootstrap did not produce ${sourceCli}`);
  }

  return nodeCommand(sourceCli);
}

async function bootstrapCodexPlusPlusSource({ sourceRoot, env }) {
  const repo = env.CODEX_PLUSPLUS_REPO || "https://github.com/b-nnett/codex-plusplus.git";
  const ref = env.CODEX_PLUSPLUS_REF || "";

  await fsp.mkdir(path.dirname(sourceRoot), { recursive: true });

  if (!fs.existsSync(path.join(sourceRoot, ".git"))) {
    await fsp.rm(sourceRoot, { recursive: true, force: true });
    await runCommand("git", ["clone", repo, sourceRoot], { env });
  }

  if (ref) {
    await runCommand("git", ["-C", sourceRoot, "fetch", "origin", ref], { env });
    await runCommand("git", ["-C", sourceRoot, "checkout", "FETCH_HEAD"], { env });
  } else {
    await runCommand("git", ["-C", sourceRoot, "pull", "--ff-only"], { env });
  }

  const installArgs = ["ci", "--workspaces", "--include-workspace-root", "--ignore-scripts"];
  const installCode = await runCommand("npm", installArgs, { env, cwd: sourceRoot, reject: false });

  if (installCode !== 0) {
    await fsp.rm(path.join(sourceRoot, "package-lock.json"), { force: true });
    await runCommand(
      "npm",
      ["install", "--workspaces", "--include-workspace-root", "--ignore-scripts"],
      { env, cwd: sourceRoot }
    );
  }

  await runCommand("npm", ["run", "build"], { env, cwd: sourceRoot });
}

function nodeCommand(scriptPath) {
  return {
    command: process.execPath,
    args: [scriptPath]
  };
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(command, env) {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
    env
  });
  const resolved = result.status === 0 ? result.stdout.trim() : "";
  return isExecutable(resolved) ? resolved : null;
}

async function runCommand(command, args, { env, cwd, reject = true } = {}) {
  return await new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit"
    });

    child.on("error", rejectPromise);
    child.on("exit", code => {
      const exitCode = code ?? 0;
      if (exitCode === 0 || !reject) {
        resolve(exitCode);
        return;
      }

      rejectPromise(new Error(`Command failed (${command} ${args.join(" ")}): ${exitCode}`));
    });
  });
}
