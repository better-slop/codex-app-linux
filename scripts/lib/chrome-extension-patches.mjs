import { parse } from "acorn";

import { CHROME_EXTENSION_HOST_CONTENT_VARIANT } from "./chrome-extension-constants.mjs";

const contractName = "Chrome plugin content-variant";
const materializerSignals = [
  ".codex-plugin",
  "plugin.json"
];

export const linuxChromeExtensionHostContentVariantContract = {
  name: "linux-chrome-extension-host-content-variant",
  find: findContentVariantContract,
  assertBefore(source) {
    const match = findContentVariantContract(source);
    if (match.status !== "patch") {
      throw new Error("Linux Chrome content variant does not require patching");
    }
  },
  apply: patchLinuxChromeExtensionHostContentVariant,
  assertAfter(source) {
    const match = findContentVariantContract(source);
    if (!["patched", "absent"].includes(match.status)) {
      throw new Error("Linux Chrome content variant was not applied");
    }
  }
};

function findContentVariantContract(source) {
  if (hasLinuxChromeExtensionHostContentVariant(source)) {
    return { status: "patched" };
  }
  return findContentVariantMaterializer(source);
}

/**
 * Upstream rewrites bundledContentVariant immediately before materializing a
 * plugin cache entry. Namespace Chrome's runtime value so a launcher update
 * replaces stale same-version caches that were created without a Linux host.
 */
export function patchLinuxChromeExtensionHostContentVariant(source) {
  if (hasLinuxChromeExtensionHostContentVariant(source)) return source;

  try {
    const match = findContentVariantMaterializer(source);
    // Newer upstream builds materialize only computer-use and visualize here.
    // Chrome's manifest is stamped directly in chrome-plugin-patches.mjs.
    if (match.status === "absent") return source;

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
    const pluginParameterSignals = [
      `${pluginParameter.name}.pluginName`,
      `${pluginParameter.name}.pluginRoot`
    ];
    if (
      ![...materializerSignals, ...pluginParameterSignals].every(signal =>
        functionSource.includes(signal)
      )
    ) {
      return;
    }

    matches.push({
      functionSource,
      property: node,
      pluginParameter: pluginParameter.name
    });
  });

  if (matches.length !== 1) {
    throw contractError(`expected one runtime materializer, found ${matches.length}`);
  }

  const [match] = matches;
  if (
    referencesParameterProperty(
      match.functionSource,
      match.pluginParameter,
      "browserSkillVariant"
    ) ||
    hasPluginNameBranch(match.functionSource, match.pluginParameter, "chrome")
  ) {
    return { status: "patch", ...match };
  }

  if (isKnownNonChromeMaterializer(match.functionSource, match.pluginParameter)) {
    return { status: "absent", ...match };
  }

  throw contractError("runtime materializer does not prove whether Chrome is handled");
}

function isKnownNonChromeMaterializer(functionSource, pluginParameter) {
  return (
    referencesParameterProperty(
      functionSource,
      pluginParameter,
      "computerUseSkillVariant"
    ) &&
    referencesParameterProperty(
      functionSource,
      pluginParameter,
      "liveVisualizationSkillVariant"
    ) &&
    hasPluginNameBranch(functionSource, pluginParameter, "computer-use") &&
    hasPluginNameBranch(functionSource, pluginParameter, "visualize")
  );
}

function referencesParameterProperty(source, parameterName, propertyName) {
  return source.includes(`${parameterName}.${propertyName}`);
}

function hasPluginNameBranch(source, parameterName, pluginName) {
  return ["`", '"', "'"].some(quote =>
    source.includes(`${parameterName}.pluginName===${quote}${pluginName}${quote}`)
  );
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
