import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readInstalledPackage,
  resolveBinaryPath,
  resolveCodexCliPath,
  resolveBundlePathsFromBinary
} from "./lib/linux-desktop.mjs";
import { printPlusPlusUsage, runCodexPlusPlus } from "./lib/plusplus.mjs";

const argv = process.argv.slice(2);

if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  printUsage();
  process.exit(0);
}

main().catch(error => {
  process.stderr.write(`codex-app-linux: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

async function main() {
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    const packageData = await readInstalledPackage();
    process.stdout.write(`${packageData.packageJson.version}\n`);
    return;
  }

  if (argv[0] === "web") {
    const serverPath = fileURLToPath(new URL("./webstrap/server.mjs", import.meta.url));
    const child = spawn(process.execPath, [serverPath, ...argv.slice(1)], {
      stdio: "inherit",
      env: process.env
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exit(code ?? 0);
    });

    process.exitCode = 0;
    return;
  }

  if (argv[0] === "--plusplus" || argv[0] === "plusplus") {
    const packageData = await readInstalledPackage();
    const binaryPath = await resolveBinaryPath({
      packageJson: packageData.packageJson
    });
    process.exitCode = await runCodexPlusPlus({
      binaryPath,
      args: argv.slice(1),
      env: process.env
    });
    return;
  }

  await launchDesktop(argv);
}

function printUsage() {
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  codex-app-linux [desktop-args...]\n`);
  process.stdout.write(`  codex-app-linux web [--port <n>] [--bind <ip>] [--open] [--token-file <path>] [--codex-app <path>] [--dangerously-disable-auth <true|false>]\n`);
  process.stdout.write(`  codex-app-linux --plusplus <install|status|repair|uninstall|doctor> [codexplusplus-options...]\n`);
  process.stdout.write(`  codex-app-linux --version\n`);
  process.stdout.write(`\n`);
  printPlusPlusUsage(process.stdout);
}

async function launchDesktop(args) {
  const packageData = await readInstalledPackage();
  const binaryPath = await resolveBinaryPath({
    packageJson: packageData.packageJson
  });
  const bundlePaths = resolveBundlePathsFromBinary(binaryPath);
  const resolvedCodex = resolveCodexCliPath({
    preferredPath: bundlePaths.codexCliPath
  });

  if (!resolvedCodex) {
    process.stderr.write("codex-app-linux: CODEX_CLI_PATH is not set and `which codex` returned nothing.\n");
    process.stderr.write("Set CODEX_CLI_PATH explicitly or install `codex` on PATH.\n");
    process.exit(1);
  }

  const child = spawn(binaryPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_CLI_PATH: resolvedCodex
    }
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}
