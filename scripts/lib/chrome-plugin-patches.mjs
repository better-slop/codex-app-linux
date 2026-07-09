import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";

import { chromePluginRoot } from "./chrome-extension-host.mjs";

const nativeManifestContract = "Linux native-host manifest diagnostics";
const browserProfileContract = "Linux Chrome profile metadata";
const macProfileSuffix = ':"Library/Application Support/Google/Chrome"';

export async function patchLinuxChromePluginResources(resourcesDir) {
  const scriptsDir = path.join(chromePluginRoot(resourcesDir), "scripts");
  const targets = [
    {
      path: path.join(scriptsDir, "check-native-host-manifest.js"),
      patch: patchLinuxNativeHostManifestCheckSource
    },
    {
      path: path.join(scriptsDir, "browser-client.mjs"),
      patch: patchLinuxBrowserClientProfileSource
    }
  ];

  for (const target of targets) {
    const source = await fs.readFile(target.path, "utf8").catch(error => {
      throw new Error(`Required Chrome plugin script is missing: ${target.path}`, {
        cause: error
      });
    });
    const patched = target.patch(source);
    if (patched !== source) await fs.writeFile(target.path, patched);
  }
}

export function patchLinuxNativeHostManifestCheckSource(source) {
  if (hasLinuxNativeHostManifestCheck(source)) return source;

  try {
    const fn = findNamedFunction(source, "getNativeHostManifestLocation");
    const functionSource = source.slice(fn.start, fn.end);
    const windowsBranch = functionSource.indexOf(
      'if (process.platform === "win32")'
    );
    if (windowsBranch === -1) throw new Error("missing Windows manifest branch");

    const insertion = `if (process.platform === "linux") {
    return {
      manifestPath: path.join(
        os.homedir(),
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }

  `;
    const insertionOffset = fn.start + windowsBranch;
    let patched =
      source.slice(0, insertionOffset) + insertion + source.slice(insertionOffset);
    const oldSupport = "This script supports macOS and Windows.";
    if (!patched.includes(oldSupport)) throw new Error("missing supported-platform message");
    patched = patched.replace(oldSupport, "This script supports macOS, Linux, and Windows.");

    if (!hasLinuxNativeHostManifestCheck(patched)) {
      throw new Error("Linux manifest branch was not applied");
    }
    return patched;
  } catch (error) {
    throw contractError(nativeManifestContract, error);
  }
}

export function patchLinuxBrowserClientProfileSource(source) {
  if (hasLinuxBrowserClientProfile(source)) return source;

  try {
    const matches = [];
    let offset = -1;
    while ((offset = source.indexOf(macProfileSuffix, offset + 1)) !== -1) {
      const prefix = source.slice(Math.max(0, offset - 256), offset);
      const match = prefix.match(
        /([A-Za-z_$][\w$]*)\(\)==="win32"\?"AppData(?:\\\\|\\)Local(?:\\\\|\\)Google(?:\\\\|\\)Chrome(?:\\\\|\\)User Data"$/
      );
      if (match) matches.push({ offset, platformFunction: match[1] });
    }

    if (matches.length !== 1) {
      throw new Error(`expected one Chrome profile root, found ${matches.length}`);
    }

    const { offset: matchOffset, platformFunction } = matches[0];
    const linuxSuffix =
      `:${platformFunction}()===\"linux\"?\".config/google-chrome\"` +
      macProfileSuffix;
    const patched =
      source.slice(0, matchOffset) +
      linuxSuffix +
      source.slice(matchOffset + macProfileSuffix.length);

    if (!hasLinuxBrowserClientProfile(patched)) {
      throw new Error("Linux Chrome profile root was not applied");
    }
    return patched;
  } catch (error) {
    throw contractError(browserProfileContract, error);
  }
}

function hasLinuxNativeHostManifestCheck(source) {
  return (
    source.includes('process.platform === "linux"') &&
    source.includes('"NativeMessagingHosts"') &&
    source.includes("supports macOS, Linux, and Windows")
  );
}

function hasLinuxBrowserClientProfile(source) {
  return /[A-Za-z_$][\w$]*\(\)==="linux"\?"\.config\/google-chrome"/.test(source);
}

function findNamedFunction(source, name) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const matches = [];
  walk(ast, node => {
    if (node.type === "FunctionDeclaration" && node.id?.name === name) {
      matches.push(node);
    }
  });
  if (matches.length !== 1) {
    throw new Error(`expected function ${name} once, found ${matches.length}`);
  }
  return matches[0];
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}

function contractError(name, error) {
  if (error?.message?.startsWith(`${name} contract changed:`)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${name} contract changed: ${message}`, { cause: error });
}
