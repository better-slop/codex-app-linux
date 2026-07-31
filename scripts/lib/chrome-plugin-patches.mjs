import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";

import { CHROME_EXTENSION_HOST_CONTENT_VARIANT } from "./chrome-extension-constants.mjs";
import { chromePluginRoot } from "./chrome-extension-host.mjs";

const nativeManifestContract = "Linux native-host manifest diagnostics";
const pluginManifestVariantContract = "Linux Chrome plugin manifest variant";

export async function patchLinuxChromePluginResources(resourcesDir) {
  const pluginRoot = chromePluginRoot(resourcesDir);
  const scriptsDir = path.join(pluginRoot, "scripts");
  // browser-client.mjs is SHA-pinned by the desktop runtime. Keep its bytes
  // intact; changing its profile metadata would disable the trusted Node REPL.
  const manifestCheckPath = path.join(scriptsDir, "check-native-host-manifest.js");
  const source = await fs.readFile(manifestCheckPath, "utf8").catch(error => {
    throw new Error(`Required Chrome plugin script is missing: ${manifestCheckPath}`, {
      cause: error
    });
  });
  const patched = patchLinuxNativeHostManifestCheckSource(source);
  if (patched !== source) await fs.writeFile(manifestCheckPath, patched);

  const pluginManifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const pluginManifestSource = await fs.readFile(pluginManifestPath, "utf8").catch(error => {
    throw new Error(`Required Chrome plugin manifest is missing: ${pluginManifestPath}`, {
      cause: error
    });
  });
  const patchedPluginManifest = patchLinuxChromePluginManifestSource(pluginManifestSource);
  if (patchedPluginManifest !== pluginManifestSource) {
    await fs.writeFile(pluginManifestPath, patchedPluginManifest);
  }
}

/** Stamp the Linux host revision into the cache identity used by upstream. */
export function patchLinuxChromePluginManifestSource(source) {
  try {
    const manifest = JSON.parse(source);
    if (manifest?.name !== "chrome") throw new Error("expected the Chrome plugin manifest");

    const currentVariant = manifest.bundledContentVariant;
    if (currentVariant === CHROME_EXTENSION_HOST_CONTENT_VARIANT) return source;
    if (currentVariant !== undefined) {
      throw new Error(`unexpected bundledContentVariant ${JSON.stringify(currentVariant)}`);
    }

    manifest.bundledContentVariant = CHROME_EXTENSION_HOST_CONTENT_VARIANT;
    return `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (error) {
    throw contractError(pluginManifestVariantContract, error);
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

function hasLinuxNativeHostManifestCheck(source) {
  try {
    const fn = findNamedFunction(source, "getNativeHostManifestLocation");
    const functionSource = source.slice(fn.start, fn.end);
    const locationShape = [
      'process.platform === "linux"',
      "manifestPath:",
      "registryKey: null",
      "registryManifestPath: null",
      "registryKeyExists: null"
    ];
    const resolvesManifestPath =
      functionSource.includes('"NativeMessagingHosts"') ||
      functionSource.includes("resolveLinuxNativeMessagingManifestPath(");

    return (
      resolvesManifestPath &&
      locationShape.every(signal => functionSource.includes(signal))
    );
  } catch {
    return false;
  }
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
