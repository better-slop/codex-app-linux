import crypto from "node:crypto";
import path from "node:path";

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

function normalizeLevel(level) {
  const input = String(level ?? "info").toLowerCase();
  return LEVELS[input] ? input : "info";
}

export function createLogger(scope, level = process.env.CODEX_WEBSTRAP_LOG_LEVEL) {
  const threshold = LEVELS[normalizeLevel(level)];

  function write(logLevel, message, fields) {
    if (LEVELS[logLevel] < threshold) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      level: logLevel,
      scope,
      msg: message
    };

    if (fields && Object.keys(fields).length > 0) {
      line.fields = fields;
    }

    const rendered = JSON.stringify(line);
    if (logLevel === "error" || logLevel === "warn") {
      process.stderr.write(`${rendered}\n`);
      return;
    }
    process.stdout.write(`${rendered}\n`);
  }

  return {
    trace(message, fields) {
      write("trace", message, fields);
    },
    debug(message, fields) {
      write("debug", message, fields);
    },
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, fields) {
      write("error", message, fields);
    }
  };
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safePathJoin(root, requestPath) {
  const normalized = requestPath.replace(/^\/+/, "");
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return fullPath;
}

export function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
