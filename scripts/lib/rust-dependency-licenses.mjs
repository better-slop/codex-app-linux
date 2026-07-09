import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { projectRoot } from "./config.mjs";

const execFileAsync = promisify(execFile);
const licenseFilePattern = /^(?:licen[cs]e|copying|unlicense|notice)(?:[-._].*)?$/i;
let renderedLicenses;

/** Build a deterministic license bundle from the Cargo.lock dependency graph. */
export async function writeRustDependencyLicenses(
  outputPath,
  manifestPath = path.join(
    projectRoot,
    "native",
    "chrome-extension-host",
    "Cargo.toml"
  )
) {
  renderedLicenses ||= renderRustDependencyLicenses(manifestPath);
  await fs.writeFile(outputPath, await renderedLicenses);
}

async function renderRustDependencyLicenses(manifestPath) {
  const { stdout } = await execFileAsync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--filter-platform",
      "x86_64-unknown-linux-musl",
      "--format-version",
      "1",
      "--manifest-path",
      manifestPath
    ],
    { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 }
  );
  const metadata = JSON.parse(stdout);
  const resolvedIds = new Set(metadata.resolve?.nodes?.map(node => node.id) || []);
  const packages = metadata.packages
    .filter(pkg => resolvedIds.has(pkg.id) && pkg.id !== metadata.resolve?.root)
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    );
  if (packages.length === 0) {
    throw new Error("Cargo metadata returned no Rust dependencies to license");
  }

  const sections = await Promise.all(packages.map(renderPackageLicenses));
  return [
    "# Rust dependency licenses",
    "",
    "Generated from `native/chrome-extension-host/Cargo.lock`. The complete",
    "license notices below ship beside the statically linked Linux host.",
    "",
    ...sections,
    ""
  ].join("\n");
}

async function renderPackageLicenses(pkg) {
  const packageDir = path.dirname(pkg.manifest_path);
  const entries = await fs.readdir(packageDir, { withFileTypes: true });
  const licensePaths = new Map();
  if (pkg.license_file) {
    const licensePath = path.resolve(packageDir, pkg.license_file);
    licensePaths.set(licensePath, path.basename(licensePath));
  }
  for (const entry of entries) {
    if (entry.isFile() && licenseFilePattern.test(entry.name)) {
      licensePaths.set(path.join(packageDir, entry.name), entry.name);
    }
  }
  if (licensePaths.size === 0) {
    throw new Error(`Rust dependency ${pkg.name} ${pkg.version} has no packaged license file`);
  }

  const notices = [];
  for (const [licensePath, name] of [...licensePaths].sort((left, right) =>
    left[1].localeCompare(right[1])
  )) {
    const text = (await fs.readFile(licensePath, "utf8")).trimEnd();
    notices.push(`### ${name}\n\n\`\`\`text\n${text}\n\`\`\``);
  }
  return [
    `## ${pkg.name} ${pkg.version}`,
    "",
    `SPDX: ${pkg.license || "not declared"}`,
    ...(pkg.repository ? [`Source: ${pkg.repository}`] : []),
    "",
    notices.join("\n\n")
  ].join("\n");
}
