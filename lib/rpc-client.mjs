/**
 * Thin, dependency-free JSONL RPC client for `pi --mode rpc`.
 *
 * - Spawns the `pi` binary in RPC mode
 * - Correlates command <-> response via `id`
 * - Streams agent events as an EventEmitter
 * - Keeps a ring buffer of recent events (for SSE replay / late subscribers)
 * - Auto-answers extension UI dialogs so a headless agent never hangs
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";

const MAX_EVENT_BUFFER = 2000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class PiRpcClient extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.piBin="pi"]      Path to the pi binary
   * @param {string} [options.cwd]             Working directory for pi
   * @param {string[]} [options.extraArgs=[]]  Extra CLI args, e.g. ["--model","anthropic/claude-sonnet-4-5"]
   * @param {boolean} [options.autoRespondUi=true] Auto-cancel extension UI dialogs
   * @param {(req: any) => object | undefined} [options.uiHandler] Optional handler for UI dialogs
   * @param {number} [options.maxRestarts=5]    Max auto-restarts after unexpected exit
   */
  constructor(options = {}) {
    super();
    this.piBin = options.piBin ?? "pi";
    this.cwd = options.cwd ?? process.cwd();
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.autoRespondUi = options.autoRespondUi ?? true;
    this.uiHandler = options.uiHandler ?? null;
    this.maxRestarts = options.maxRestarts ?? 5;

    this.proc = null;
    this.pending = new Map(); // id -> { resolve, reject }
    this.eventSeq = 0;
    this.events = []; // ring buffer of enriched events
    this.stderrTail = []; // last stderr lines
    this.stopping = false;
    this.restartAttempts = 0;
    this.startedAt = null;
    this._restartTimer = null;
  }

  /** Spawn pi in RPC mode and start parsing its output. */
  start() {
    if (this.stopping) return;
    const args = ["--mode", "rpc", ...this.extraArgs];
    const proc = spawn(this.piBin, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;
    this.startedAt = new Date();
    this.restartAttempts = 0;

    this._attachStdout(proc);
    this._attachStderr(proc);
    proc.on("error", (err) => this.emit("proc_error", err));
    proc.on("exit", (code, signal) => this._handleExit(code, signal));
    this.emit("started", { pid: proc.pid, args });
    return this;
  }

  _attachStdout(proc) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) this._onLine(line);
      }
    });
    proc.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer.length > 0) {
        let line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        if (line.length > 0) this._onLine(line);
      }
    });
  }

  _attachStderr(proc) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    proc.stderr.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        this.stderrTail.push(line);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        this.emit("stderr", line);
      }
    });
    proc.stderr.on("end", () => {
      buffer += decoder.end();
      if (buffer.length > 0) {
        const line = buffer.replace(/\r$/, "");
        this.stderrTail.push(line);
        this.emit("stderr", line);
      }
    });
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.emit("parse_error", { line, error: err.message });
      return;
    }

    if (msg && msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      this.emit("response", msg);
      return;
    }

    if (msg && msg.type === "extension_ui_request") {
      this.emit("ui_request", msg);
      this._handleUiRequest(msg);
      return;
    }

    this._pushEvent(msg);
  }

  _handleUiRequest(req) {
    // Fire-and-forget UI methods need no reply.
    if (!DIALOG_METHODS.has(req.method)) return;

    if (!this.autoRespondUi) return;

    let reply = this.uiHandler ? this.uiHandler(req) : undefined;
    if (!reply) {
      // Headless default: dismiss the dialog (extension receives undefined/false).
      reply = { type: "extension_ui_response", id: req.id, cancelled: true };
    }
    this._write(reply);
  }

  _pushEvent(msg) {
    this.eventSeq += 1;
    const enriched = { ...msg, _seq: this.eventSeq, _ts: Date.now() };
    this.events.push(enriched);
    if (this.events.length > MAX_EVENT_BUFFER) this.events.shift();
    this.emit("event", enriched);
    this.emit(`event:${msg.type}`, enriched);
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      throw new Error("pi process is not running");
    }
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Send a command and resolve with its `response` object. */
  send(command) {
    const id = command.id ?? randomUUID();
    const cmd = { ...command, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._write(cmd);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Current monotonic event sequence number (use as an SSE cursor). */
  lastSeq() {
    return this.eventSeq;
  }

  /** Return events after a given sequence number (inclusive of > since). */
  eventsSince(seq = 0) {
    return this.events.filter((e) => e._seq > seq);
  }

  /** Resolve on the next `agent_settled` whose seq is greater than `afterSeq`. */
  waitForSettled(afterSeq, timeoutMs = 60_000) {
    return new Promise((resolve) => {
      let timer;
      const handler = (event) => {
        if (event.type === "agent_settled" && event._seq > afterSeq) {
          cleanup();
          resolve(event);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", handler);
      };
      this.on("event", handler);
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
    });
  }

  /** True when the pi subprocess is alive and writable. */
  isRunning() {
    return Boolean(this.proc && this.proc.stdin && this.proc.stdin.writable);
  }

  _handleExit(code, signal) {
    const proc = this.proc;
    this.proc = null;
    for (const [, p] of this.pending) {
      p.reject(new Error(`pi exited before responding (code=${code}, signal=${signal})`));
    }
    this.pending.clear();
    this.emit("exit", { code, signal, pid: proc?.pid });

    if (this.stopping) return;

    this.restartAttempts += 1;
    if (this.restartAttempts > this.maxRestarts) {
      this.emit("gave_up", { attempts: this.restartAttempts });
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.restartAttempts - 1), 15_000);
    this.emit("restarting", { delay, attempts: this.restartAttempts });
    this._restartTimer = setTimeout(() => this.start(), delay);
  }

  /** Abort any in-flight agent operation. */
  async abort() {
    return this.send({ type: "abort" });
  }

  dispose() {
    this.stopping = true;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.removeAllListeners();
  }
}
