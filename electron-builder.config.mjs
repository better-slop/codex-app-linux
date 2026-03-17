const stageAppDir = process.env.CODEX_STAGE_APP_DIR;
const outputDir = process.env.CODEX_OUTPUT_DIR;
const executableName = process.env.CODEX_APP_EXECUTABLE_NAME || "codex-desktop";

if (!stageAppDir) {
  throw new Error("CODEX_STAGE_APP_DIR is required");
}

if (!outputDir) {
  throw new Error("CODEX_OUTPUT_DIR is required");
}

export default {
  directories: {
    app: stageAppDir,
    output: outputDir
  },
  electronVersion: "40.0.0",
  npmRebuild: false,
  buildDependenciesFromSource: false,
  extraMetadata: {
    main: ".vite/build/bootstrap.js"
  },
  asar: true,
  files: [
    {
      from: ".",
      filter: [
        "**/*",
        ".vite/**/*",
        "!**/.DS_Store",
        "!**/*.map"
      ]
    }
  ],
  linux: {
    target: ["dir"],
    executableName,
    category: "Development"
  }
};
