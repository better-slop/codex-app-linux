import { parse } from "acorn";

import { CHROME_EXTENSION_HOST_CONTENT_VARIANT } from "./chrome-extension-constants.mjs";

const contractName = "Chrome plugin content-variant";
const materializerSignals = [
  ".browserSkillVariant",
  ".computerUseSkillVariant",
  ".pluginRoot",
  ".codex-plugin"
];

export const linuxChromeExtensionHostContentVariantContract = {
  name: "linux-chrome-extension-host-content-variant",
  find: findContentVariantMaterializer,
  assertBefore(source) {
    if (hasLinuxChromeExtensionHostContentVariant(source)) {
      throw new Error("Linux Chrome content variant is already present");
    }
    findContentVariantMaterializer(source);
  },
  apply: patchLinuxChromeExtensionHostContentVariant,
  assertAfter(source) {
    if (!hasLinuxChromeExtensionHostContentVariant(source)) {
      throw new Error("Linux Chrome content variant was not applied");
    }
  }
};

/**
 * Upstream rewrites bundledContentVariant immediately before materializing a
 * plugin cache entry. Namespace Chrome's runtime value so a launcher update
 * replaces stale same-version caches that were created without a Linux host.
 */
export function patchLinuxChromeExtensionHostContentVariant(source) {
  if (hasLinuxChromeExtensionHostContentVariant(source)) return source;

  try {
    const match = findContentVariantMaterializer(source);
    const variantName = source.slice(match.property.value.start, match.property.value.end);
    const replacement =
      `${match.pluginParameter}.pluginName===\`chrome\`?` +
      `\`\${${variantName}}-${CHROME_EXTENSION_HOST_CONTENT_VARIANT}\`:${variantName}`;

    return (
      source.slice(0, match.property.value.start) +
      replacement +
      source.slice(match.property.value.end)
    );
  } catch (error) {
    if (error?.message?.startsWith(`${contractName} contract changed:`)) {
      throw error;
    }
    throw contractError(error instanceof Error ? error.message : String(error), error);
  }
}

export function hasLinuxChromeExtensionHostContentVariant(source) {
  return (
    source.includes(CHROME_EXTENSION_HOST_CONTENT_VARIANT) &&
    /bundledContentVariant:[A-Za-z_$][\w$]*\.pluginName===`chrome`\?/.test(source)
  );
}

function findContentVariantMaterializer(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw contractError(`main bundle is not valid JavaScript: ${error.message}`, error);
  }

  const matches = [];
  walk(ast, [], (node, ancestors) => {
    if (!isBundledContentVariantProperty(node)) return;

    const fn = [...ancestors].reverse().find(isFunctionNode);
    const pluginParameter = fn?.params?.[0];
    if (!fn || pluginParameter?.type !== "Identifier") return;

    const functionSource = source.slice(fn.start, fn.end);
    if (!materializerSignals.every(signal => functionSource.includes(signal))) return;

    matches.push({
      property: node,
      pluginParameter: pluginParameter.name
    });
  });

  if (matches.length !== 1) {
    throw contractError(`expected one runtime materializer, found ${matches.length}`);
  }

  return matches[0];
}

function isBundledContentVariantProperty(node) {
  return (
    node?.type === "Property" &&
    !node.computed &&
    node.key?.type === "Identifier" &&
    node.key.name === "bundledContentVariant" &&
    node.value?.type === "Identifier"
  );
}

function isFunctionNode(node) {
  return [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression"
  ].includes(node?.type);
}

function walk(node, ancestors, visit) {
  if (!node || typeof node !== "object") return;
  visit(node, ancestors);

  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, nextAncestors, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, nextAncestors, visit);
    }
  }
}

function contractError(message, cause) {
  return new Error(`${contractName} contract changed: ${message}`, { cause });
}
