import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { createLogger, toErrorMessage } from "./util.mjs";

export const MAX_IPC_FRAME_BYTES = 256 * 1024 * 1024;
export const MAX_IPC_BUFFER_BYTES = 512 * 1024 * 1024;

export function getDefaultUdsSocketPath() {
  if (process.platform === "win32") {
    return path.join("\\\\.\\pipe", "codex-ipc");
  }
  const base = path.join(os.tmpdir(), "codex-ipc");
  const uid = process.getuid?.();
  return path.join(base, uid ? `ipc-${uid}.sock` : "ipc.sock");
}

export function encodeFrame(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const payload = Buffer.from(json, "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  constructor({ maxFrameBytes = MAX_IPC_FRAME_BYTES, maxBufferBytes = MAX_IPC_BUFFER_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.buffer = Buffer.alloc(0);
    this.currentFrameLength = null;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) {
      return [];
    }

    if (this.buffer.length + chunk.length > this.maxBufferBytes) {
      throw new Error(`IPC buffer exceeded limit (${this.maxBufferBytes} bytes)`);
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    for (;;) {
      if (this.currentFrameLength == null) {
        if (this.buffer.length < 4) {
          break;
        }

        this.currentFrameLength = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);

        if (this.currentFrameLength > this.maxFrameBytes) {
          throw new Error(
            `IPC frame exceeded limit (${this.currentFrameLength} > ${this.maxFrameBytes} bytes)`
          );
        }
      }

      if (this.currentFrameLength == null || this.buffer.length < this.currentFrameLength) {
        break;
      }

      const payload = this.buffer.subarray(0, this.currentFrameLength);
      this.buffer = this.buffer.subarray(this.currentFrameLength);
      this.currentFrameLength = null;

      let parsed;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        throw new Error(`Invalid IPC JSON frame: ${toErrorMessage(error)}`);
      }

      messages.push(parsed);
    }

    return messages;
  }
}

export class UdsIpcClient extends EventEmitter {
  constructor({
    socketPath = getDefaultUdsSocketPath(),
    clientType = "desktop-webstrapper",
    reconnectMs = 1000,
    requestTimeoutMs = 5000,
    logger
  } = {}) {
    super();
    this.socketPath = socketPath;
    this.clientType = clientType;
    this.reconnectMs = reconnectMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger || createLogger("uds-ipc");

    this.decoder = new FrameDecoder();
    this.socket = null;
    this.connected = false;
    this.initialized = false;
    this.stopped = false;
    this.reconnectTimer = null;
    this.clientId = "initializing-client";
    this.pending = new Map();
  }

  async start() {
    this.stopped = false;
    await this._connectNow();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._rejectAllPending(new Error("ipc client stopped"));

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    this.initialized = false;
  }

  isReady() {
    return this.connected && this.initialized;
  }

  async sendRequest(method, params, options = {}) {
    const requestId = crypto.randomUUID();
    const payload = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      method,
      params,
      targetClientId: options.targetClientId
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`IPC request timeout for method ${method}`));
      }, options.timeoutMs || this.requestTimeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        method
      });

      try {
        this._write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  sendBroadcast(method, params) {
    const payload = {
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      params,
      version: 1
    };
    this._write(payload);
  }

  _write(payload) {
    if (!this.socket || !this.socket.writable) {
      throw new Error("IPC socket is not connected");
    }

    const frame = encodeFrame(payload);
    this.socket.write(frame);
  }

  async _connectNow() {
    if (this.stopped) {
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const socket = net.connect(this.socketPath, () => {
        this.logger.info("UDS connected", { socketPath: this.socketPath });
        this.socket = socket;
        this.connected = true;
        this.initialized = false;
        this.clientId = "initializing-client";

        this._initialize()
          .then(() => {
            this.emit("connected", { socketPath: this.socketPath, clientId: this.clientId });
            finish();
          })
          .catch((error) => {
            this.logger.warn("UDS initialize failed", { error: toErrorMessage(error) });
            socket.destroy();
            finish();
          });
      });

      socket.on("data", (chunk) => {
        try {
          const messages = this.decoder.push(chunk);
          for (const message of messages) {
            this._handleIncomingMessage(message);
          }
        } catch (error) {
          this.logger.warn("UDS frame decode failed", { error: toErrorMessage(error) });
          socket.destroy();
        }
      });

      socket.on("error", (error) => {
        this.logger.debug("UDS socket error", { error: toErrorMessage(error) });
      });

      socket.on("close", () => {
        const wasInitialized = this.initialized;
        this.connected = false;
        this.initialized = false;
        this.socket = null;
        this.clientId = "initializing-client";
        this._rejectAllPending(new Error("ipc socket closed"));
        this.emit("disconnected");

        if (!this.stopped) {
          this._scheduleReconnect();
        }

        if (!wasInitialized) {
          finish();
        }
      });

      socket.on("end", () => {
        socket.destroy();
      });
    });
  }

  async _initialize() {
    const response = await this.sendRequest("initialize", {
      clientType: this.clientType
    });

    if (response?.resultType === "success" && response?.result?.clientId) {
      this.clientId = response.result.clientId;
      this.initialized = true;
      return;
    }

    throw new Error(`Unexpected initialize response: ${JSON.stringify(response)}`);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this._connectNow();
    }, this.reconnectMs);
  }

  _handleIncomingMessage(message) {
    switch (message?.type) {
      case "broadcast": {
        this.emit("broadcast", message);
        break;
      }
      case "response": {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message);
        break;
      }
      case "client-discovery-request": {
        this._write({
          type: "client-discovery-response",
          requestId: message.requestId,
          response: { canHandle: false }
        });
        break;
      }
      case "request": {
        this.emit("request", message);
        break;
      }
      default: {
        this.emit("unknown", message);
      }
    }
  }

  _rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
