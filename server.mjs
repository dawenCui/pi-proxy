/**
 * pi-http-service
 *
 * A dependency-free HTTP server that controls a `pi --mode rpc` subprocess so
 * external systems (Home Assistant, scripts, dashboards, etc.) can send the
 * agent commands over plain HTTP.
 *
 * Endpoints:
 *   GET  /healthz            liveness probe (no auth)
 *   GET  /                   API index
 *   GET  /ui                 tiny browser console (uses /events SSE)
 *   GET  /status             get_state + last assistant text + liveness
 *   GET  /messages           full conversation (get_messages)
 *   GET  /last               last assistant text
 *   POST /prompt             { message, wait?, streamingBehavior?, images? }
 *   POST /command            arbitrary RPC command passthrough
 *   POST /bash               { command }
 *   POST /abort              abort current run
 *   GET  /events             Server-Sent Events stream (?since=<seq>, ?only=a,b)
 *   GET  /logs               recent activity (service/pi/chat) as JSON
 *   GET  /logs/stream        SSE stream of activity (service/pi/chat)
 *
 * Config (env vars win over config.json):
 *   PI_HTTP_HOST       default 127.0.0.1   (use 0.0.0.0 to expose on LAN for HA)
 *   PI_HTTP_PORT       default 8787
 *   PI_HTTP_TOKEN      optional bearer token
 *   PI_HTTP_WAIT_MS    default wait timeout for /prompt wait=true (default 60000)
 *   PI_HTTP_LOG_DIR    log directory (default: <this dir>/logs)
 *   PI_HTTP_LOG_MAX_SIZE  rotate log above this many bytes (default 10MB)
 *   PI_HTTP_LOG_MAX_FILES number of rotated files kept (default 5)
 *   PI_HTTP_UI_PREFILL_TOKEN  auto | always | never (default auto)
 *   PI_BIN             default "pi"
 *   PI_CWD             working directory for pi (default: this file's directory)
 *   PI_ARGS            extra CLI args for pi, shell-style, e.g.
 *                      --model anthropic/claude-sonnet-4-5 --no-session
 */

import http from "node:http";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "./lib/rpc-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function shlex(str) {
  const out = [];
  let cur = "";
  let quote = null;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));
} catch {
  /* no config.json */
}

const config = {
  host: process.env.PI_HTTP_HOST ?? fileConfig.host ?? "127.0.0.1",
  port: Number(process.env.PI_HTTP_PORT ?? fileConfig.port ?? 8787),
  token: process.env.PI_HTTP_TOKEN ?? fileConfig.token ?? "",
  waitMs: Number(process.env.PI_HTTP_WAIT_MS ?? fileConfig.waitMs ?? 60_000),
  piBin: process.env.PI_BIN ?? fileConfig.piBin ?? "pi",
  cwd: process.env.PI_CWD ?? fileConfig.cwd ?? __dirname,
  extraArgs: process.env.PI_ARGS
    ? shlex(process.env.PI_ARGS)
    : Array.isArray(fileConfig.extraArgs)
      ? fileConfig.extraArgs
      : [],
  autoRespondUi: (process.env.PI_AUTO_RESPOND_UI ?? "1") !== "0",
  uiHandler: null, // optional hook; see README
  // "auto" (default): prefill the /ui token box only for loopback clients;
  // "always": prefill for everyone; "never": never prefill.
  uiPrefillToken: process.env.PI_HTTP_UI_PREFILL_TOKEN ?? fileConfig.uiPrefillToken ?? "auto",
  // Webhook callback URL (e.g., Home Assistant webhook)
  webhookUrl: process.env.PI_HTTP_WEBHOOK_URL ?? fileConfig.webhookUrl ?? "",
};

// ---------------------------------------------------------------------------
// Logging: console + rotating file + in-memory activity feed
// ---------------------------------------------------------------------------

const logDir = process.env.PI_HTTP_LOG_DIR ?? fileConfig.logDir ?? join(__dirname, "logs");
const logFile = join(logDir, "pi-http.log");
const logMaxSize = Number(process.env.PI_HTTP_LOG_MAX_SIZE ?? fileConfig.logMaxSize ?? 10 * 1024 * 1024);
const logMaxFiles = Number(process.env.PI_HTTP_LOG_MAX_FILES ?? fileConfig.logMaxFiles ?? 5);

function rotateLogIfNeeded() {
  try {
    if (!existsSync(logFile) || statSync(logFile).size < logMaxSize) return;
    for (let i = logMaxFiles - 1; i >= 1; i--) {
      const from = join(logDir, `pi-http.log.${i}`);
      const to = join(logDir, `pi-http.log.${i + 1}`);
      if (existsSync(from)) {
        if (existsSync(to)) unlinkSync(to);
        renameSync(from, to);
      }
    }
    const first = join(logDir, "pi-http.log.1");
    if (existsSync(first)) unlinkSync(first);
    renameSync(logFile, first);
  } catch {
    /* rotation is best-effort */
  }
}

function writeLogLine(line) {
  try {
    mkdirSync(logDir, { recursive: true });
    rotateLogIfNeeded();
    appendFileSync(logFile, line + "\n");
  } catch {
    /* never let logging crash the service */
  }
}

const ACTIVITY_MAX = 2000;
const activityEmitter = new EventEmitter();
let activitySeq = 0;
const activity = [];

function addActivity(entry) {
  activitySeq += 1;
  const e = { seq: activitySeq, ts: Date.now(), ...entry };
  activity.push(e);
  if (activity.length > ACTIVITY_MAX) activity.shift();
  activityEmitter.emit("entry", e);
  return e;
}

function activitySince(seq = 0) {
  return activity.filter((e) => e.seq > seq);
}

function log(msg) {
  const line = `[pi-http ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  writeLogLine(line);
  addActivity({ source: "service", level: "info", text: msg });
}

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

const client = new PiRpcClient({
  piBin: config.piBin,
  cwd: config.cwd,
  extraArgs: config.extraArgs,
  autoRespondUi: config.autoRespondUi,
  uiHandler: config.uiHandler,
});
client.on("started", ({ pid, args }) => {
  log(`pi started pid=${pid} args=[${args.join(" ")}]`);
});
client.on("exit", ({ code, signal }) => {
  log(`pi exited code=${code} signal=${signal}`);
});
client.on("restarting", ({ delay, attempts }) => {
  log(`pi restarting in ${delay}ms (attempt ${attempts})`);
});
client.on("gave_up", () => log("pi gave up restarting; service will return errors until restarted"));
client.on("proc_error", (err) => log(`pi spawn error: ${err.message}`));
client.on("stderr", (line) => {
  if (line && line.trim()) {
    const text = line.trim();
    console.error(`[pi:stderr] ${text}`);
    writeLogLine(`[pi:stderr] ${text}`);
    addActivity({ source: "pi", level: "warn", text });
  }
});

// Record assistant answers into the activity feed once each turn settles, so
// the UI / log shows the Q&A history (e.g. prompts coming from HA).
let lastAssistantAnswer = null;
let lastUserPrompt = null;

// Track the last user prompt for webhook callback
const originalPromptHandler = handlePrompt;

client.on("event:agent_settled", () => {
  getLastAssistantText()
    .then(async (text) => {
      if (text && text !== lastAssistantAnswer) {
        lastAssistantAnswer = text;
        addActivity({ source: "chat", kind: "assistant", text });

        // Send webhook callback if configured
        if (config.webhookUrl) {
          const now = new Date();
          const localTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d{3}Z$/, '');
          sendWebhook({
            event: "agent_settled",
            text: text,
            prompt: lastUserPrompt,
            timestamp: localTime,
          });
        }
      }
    })
    .catch(() => {});
});

// Send webhook callback
async function sendWebhook(payload) {
  if (!config.webhookUrl) return;
  try {
    const url = new URL(config.webhookUrl);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? await import("node:https") : await import("node:http");

    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      log(`webhook callback: ${res.statusCode}`);
    });

    req.on("error", (err) => {
      log(`webhook callback error: ${err.message}`);
    });

    req.write(body);
    req.end();
  } catch (err) {
    log(`webhook callback failed: ${err.message}`);
  }
}
client.start();

const serverStartTime = Date.now();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token",
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...CORS,
  });
  res.end(body);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!config.token) return true;
  const h = req.headers["authorization"] ?? "";
  if (h === `Bearer ${config.token}`) return true;
  if (req.headers["x-auth-token"] === config.token) return true;
  const u = new URL(req.url, "http://localhost");
  if (u.searchParams.get("token") === config.token) return true;
  return false;
}

function resolveWaitMs(wait) {
  if (wait === true) return config.waitMs;
  if (typeof wait === "number" && wait > 0) return wait;
  if (typeof wait === "string" && wait !== "" && Number(wait) > 0) return Number(wait);
  return 0;
}

function parseList(u, key) {
  const v = u.searchParams.get(key);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

async function rpc(cmd) {
  const res = await client.send(cmd);
  if (!res.success) {
    throw new Error(res.error ?? `command ${cmd.type} failed`);
  }
  return res.data;
}

async function getState() {
  try {
    return (await rpc({ type: "get_state" })) ?? null;
  } catch {
    return null;
  }
}

async function getLastAssistantText() {
  try {
    const data = await rpc({ type: "get_last_assistant_text" });
    return data?.text ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePrompt(body, res) {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json(res, 400, { ok: false, error: "message (string) is required" });

  // Track last user prompt for webhook callback
  lastUserPrompt = message;

  const seqBefore = client.lastSeq();
  const cmd = { type: "prompt", message };
  if (body.streamingBehavior) cmd.streamingBehavior = body.streamingBehavior;
  if (Array.isArray(body.images)) cmd.images = body.images;

  let response;
  try {
    response = await client.send(cmd);
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
  if (!response.success) {
    return json(res, 422, { ok: false, error: response.error ?? "prompt rejected" });
  }

  addActivity({ source: "chat", kind: "user", text: message });
  log(`prompt accepted (${message.length} chars)${body.streamingBehavior ? " " + body.streamingBehavior : ""}`);

  const waitMs = resolveWaitMs(body.wait);
  if (waitMs > 0) {
    const settled = await client.waitForSettled(seqBefore, waitMs);
    return json(res, 200, {
      ok: true,
      accepted: true,
      settled: Boolean(settled),
      timedOut: !settled,
      answer: await getLastAssistantText(),
      status: await getState(),
    });
  }

  return json(res, 202, { ok: true, accepted: true, queued: Boolean(body.streamingBehavior) });
}

async function handleCommand(body, res) {
  const { wait, ...command } = body ?? {};
  if (!command || typeof command !== "object" || !command.type) {
    return json(res, 400, { ok: false, error: "command object with a 'type' field is required" });
  }
  const seqBefore = client.lastSeq();
  log(`command: ${command.type}`);
  let response;
  try {
    response = await client.send(command);
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }

  const waitMs = resolveWaitMs(wait);
  if (waitMs > 0 && command.type === "prompt") {
    const settled = await client.waitForSettled(seqBefore, waitMs);
    return json(res, 200, {
      ok: response.success,
      response,
      settled: Boolean(settled),
      timedOut: !settled,
      answer: await getLastAssistantText(),
    });
  }
  return json(res, 200, { ok: response.success, response });
}

async function handleStatus(res) {
  const [state, lastText] = await Promise.all([getState(), getLastAssistantText()]);
  return json(res, 200, {
    ok: true,
    running: client.isRunning(),
    pid: client.proc?.pid ?? null,
    uptimeSec: Math.floor((Date.now() - serverStartTime) / 1000),
    lastSeq: client.lastSeq(),
    lastAssistantText: lastText,
    state,
  });
}

async function handleBash(body, res) {
  const command = typeof body.command === "string" ? body.command : "";
  if (!command) return json(res, 400, { ok: false, error: "command (string) is required" });
  log(`bash: ${command.slice(0, 200)}`);
  try {
    const data = await rpc({ type: "bash", command, id: body.id });
    return json(res, 200, { ok: true, ...data });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS,
  });
  res.write("retry: 3000\n\n");

  const u = new URL(req.url, "http://localhost");
  const since = Number(u.searchParams.get("since") ?? 0);
  const only = parseList(u, "only");
  const includeResponses = u.searchParams.get("responses") === "1";

  const send = (evt) => {
    if (only.length && !only.includes(evt.type)) return;
    res.write(`id: ${evt._seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  };

  for (const evt of client.eventsSince(since)) send(evt);

  const onEvent = (evt) => send(evt);
  const onResponse = (msg) => {
    if (includeResponses) res.write(`event: response\ndata: ${JSON.stringify(msg)}\n\n`);
  };
  client.on("event", onEvent);
  if (includeResponses) client.on("response", onResponse);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    client.off("event", onEvent);
    client.off("response", onResponse);
  });
}

function handleLogSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS,
  });
  res.write("retry: 3000\n\n");

  const u = new URL(req.url, "http://localhost");
  const since = Number(u.searchParams.get("since") ?? 0);
  const send = (e) => res.write(`id: ${e.seq}\nevent: log\ndata: ${JSON.stringify(e)}\n\n`);

  for (const e of activitySince(since)) send(e);

  const onEntry = (e) => send(e);
  activityEmitter.on("entry", onEntry);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    activityEmitter.off("entry", onEntry);
  });
}

// ---------------------------------------------------------------------------
// HTML console (/ui)
// ---------------------------------------------------------------------------

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi 控制台</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 14px 18px; background: #161a22; border-bottom: 1px solid #2a2f3a; }
  h1 { margin: 0; font-size: 18px; }
  #status { font-size: 12px; color: #9aa3b2; margin-top: 4px; }
  main { display: flex; flex-direction: column; gap: 12px; padding: 18px; max-width: 960px; margin: 0 auto; }
  .row { display: flex; gap: 8px; }
  textarea { flex: 1; min-height: 64px; background: #161a22; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px; font-size: 14px; resize: vertical; }
  button { background: #2b6cb0; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; font-size: 14px; }
  button:hover { background: #2c5282; }
  button.ghost { background: #2a2f3a; }
  button.active { background: #2b6cb0; }
  input[type=password] { flex: 1; min-width: 0; background: #161a22; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px; font-size: 14px; }
  .tabs { display: flex; gap: 8px; }
  .panel { background: #161a22; border: 1px solid #2a2f3a; border-radius: 8px; padding: 12px; height: 62vh; overflow-y: auto; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; }
  .user { color: #7fb3ff; }
  .assistant { color: #c3f0c3; }
  .tool { color: #d8b4fe; }
  .meta { color: #6b7280; }
  .log-line { color: #9aa3b2; }
  .log-pi { color: #f0c674; }
  .stream { color: #8ab4f8; }
</style>
</head>
<body>
<header>
  <h1>pi 控制台</h1>
  <div class="row" style="margin-top:8px;">
    <input id="token" type="password" placeholder="访问令牌（服务未启用令牌可留空）" autocomplete="off">
    <button class="ghost" onclick="reconnect()">连接</button>
  </div>
  <div id="status">连接中…</div>
</header>
<main>
  <div class="tabs">
    <button id="tabChat" class="active" onclick="showTab('chat')">对话</button>
    <button id="tabLog" onclick="showTab('log')">日志</button>
  </div>
  <div id="chat" class="panel"></div>
  <div id="log" class="panel" style="display:none"></div>
</main>
<script>
var chatEl = document.getElementById("chat");
var logEl = document.getElementById("log");
var statusEl = document.getElementById("status");
var es = null;
var logsEs = null;
var streamBuf = "";
var streamDiv = null;

// 令牌：URL 里带 ?token= 优先，否则用服务端注入的预填值
var q = new URLSearchParams(location.search).get("token");
document.getElementById("token").value = q === null ? __PREFILL_TOKEN__ : q;

function tokenQ() {
  var t = document.getElementById("token").value.trim();
  return t ? "?token=" + encodeURIComponent(t) : "";
}
function withToken(path) {
  return path + tokenQ();
}
function append(el, cls, text) {
  var div = document.createElement("div");
  div.className = cls || "";
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.childNodes.length > 800) el.removeChild(el.firstChild);
}
function showTab(name) {
  document.getElementById("chat").style.display = name === "chat" ? "" : "none";
  document.getElementById("log").style.display = name === "log" ? "" : "none";
  document.getElementById("tabChat").className = name === "chat" ? "active" : "ghost";
  document.getElementById("tabLog").className = name === "log" ? "active" : "ghost";
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}
function startStream() {
  if (streamDiv) return;
  streamDiv = document.createElement("div");
  streamDiv.className = "stream";
  chatEl.appendChild(streamDiv);
}
function appendStream(delta) {
  startStream();
  streamBuf += delta;
  streamDiv.textContent = streamBuf;
  chatEl.scrollTop = chatEl.scrollHeight;
}
function endStream() {
  if (streamDiv) { streamDiv.remove(); streamDiv = null; }
  streamBuf = "";
}

function renderActivity(evt) {
  if (evt.source === "chat") {
    if (evt.kind === "user") append(chatEl, "user", "> " + evt.text);
    else if (evt.kind === "assistant") { endStream(); append(chatEl, "assistant", evt.text); }
    return;
  }
  var cls = evt.source === "pi" ? "log-pi" : "log-line";
  append(logEl, cls, "[" + fmtTime(evt.ts) + "][" + (evt.source || "?") + "] " + (evt.text || ""));
}

async function connectEvents() {
  if (es) es.close();
  var since = 0;
  try {
    var s = await fetch(withToken("/status"));
    var d = await s.json();
    if (d.lastSeq) since = d.lastSeq;
  } catch (e) {}
  var url = withToken("/events");
  url += (url.indexOf("?") === -1 ? "?" : "&") + "since=" + since;
  es = new EventSource(url);
  es.addEventListener("message_update", function (e) {
    var evt = JSON.parse(e.data);
    var d = evt.assistantMessageEvent || {};
    if (d.type === "text_delta") appendStream(d.delta);
    if (d.type === "thinking_delta") append(logEl, "meta", "💭 " + d.delta);
  });
  es.addEventListener("tool_execution_start", function (e) {
    var evt = JSON.parse(e.data);
    append(chatEl, "tool", "🔧 " + evt.toolName + " " + JSON.stringify(evt.args || {}));
  });
  es.addEventListener("tool_execution_end", function (e) {
    var evt = JSON.parse(e.data);
    append(chatEl, "meta", "✓ " + evt.toolName + (evt.isError ? " (出错)" : " 完成"));
  });
  es.addEventListener("agent_settled", function () {
    endStream();
    append(chatEl, "meta", "── 本轮结束 ──");
  });
  es.onopen = function () { statusEl.textContent = "事件流已连接"; };
  es.onerror = function () { statusEl.textContent = "事件流断开，重连中…"; };
}

function connectLogs(since) {
  if (logsEs) logsEs.close();
  var url = withToken("/logs/stream");
  url += (url.indexOf("?") === -1 ? "?" : "&") + "since=" + (since || 0);
  logsEs = new EventSource(url);
  logsEs.addEventListener("log", function (e) {
    renderActivity(JSON.parse(e.data));
  });
}

async function loadHistory() {
  try {
    var res = await fetch(withToken("/logs"));
    var data = await res.json();
    (data.entries || []).forEach(renderActivity);
    connectLogs(data.lastSeq || 0);
  } catch (e) {
    append(logEl, "meta", "历史日志加载失败: " + e.message);
    connectLogs(0);
  }
}

function reconnect() {
  append(chatEl, "meta", "重新连接…");
  connectEvents();
  loadHistory();
}

loadHistory();
connectEvents();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const path = u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Liveness probe stays token-free on purpose.
  if (path === "/healthz" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      running: client.isRunning(),
      uptimeSec: Math.floor((Date.now() - serverStartTime) / 1000),
    });
  }

  // The browser console shell is static HTML with no data, so it is served
  // without auth. Its API calls still require the token, which the page
  // forwards from its token input box (pre-filled for loopback clients unless
  // PI_HTTP_UI_PREFILL_TOKEN says otherwise).
  if (path === "/ui" && req.method === "GET") {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const prefill = config.uiPrefillToken === "always" || (config.uiPrefillToken !== "never" && loopback);
    const tokenLiteral = JSON.stringify(prefill ? config.token ?? "" : "").replace(/</g, "\\u003c");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS });
    return res.end(HTML.replace("__PREFILL_TOKEN__", tokenLiteral));
  }

  if (!authorized(req)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    if (path === "/" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        service: "pi-http-service",
        version: "1.0.0",
        endpoints: {
          "/healthz": "GET  liveness (no auth)",
          "/status": "GET  state + last assistant text",
          "/messages": "GET  full conversation",
          "/last": "GET  last assistant text",
          "/prompt": "POST { message, wait?, streamingBehavior?, images? }",
          "/command": "POST arbitrary RPC command",
          "/bash": "POST { command }",
          "/abort": "POST abort current run",
          "/events": "GET  SSE stream (?since=<seq>, ?only=type1,type2, ?responses=1)",
          "/logs": "GET  recent activity (service/pi/chat)",
          "/logs/stream": "GET  SSE stream of activity",
          "/ui": "GET  browser console",
        },
      });
    }

    if (path === "/events" && req.method === "GET") {
      return handleSse(req, res);
    }

    if (path === "/logs/stream" && req.method === "GET") {
      return handleLogSse(req, res);
    }

    if (path === "/logs" && req.method === "GET") {
      const since = Number(u.searchParams.get("since") ?? 0);
      return json(res, 200, { ok: true, lastSeq: activitySeq, entries: activitySince(since) });
    }

    if (path === "/status" && req.method === "GET") {
      return await handleStatus(res);
    }

    if (path === "/messages" && req.method === "GET") {
      try {
        const data = await rpc({ type: "get_messages" });
        return json(res, 200, { ok: true, messages: data?.messages ?? [] });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    if (path === "/last" && req.method === "GET") {
      return json(res, 200, { ok: true, text: await getLastAssistantText() });
    }

    if (path === "/prompt" && req.method === "POST") {
      return await handlePrompt(await readBody(req), res);
    }

    if (path === "/command" && req.method === "POST") {
      return await handleCommand(await readBody(req), res);
    }

    if (path === "/bash" && req.method === "POST") {
      return await handleBash(await readBody(req), res);
    }

    if (path === "/abort" && req.method === "POST") {
      try {
        const data = await client.abort();
        return json(res, 200, { ok: true, ...data });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
  log(`pi cwd=${config.cwd}`);
  log(`token ${config.token ? "ENABLED" : "disabled"}`);
  if (config.extraArgs.length) log(`pi args: ${config.extraArgs.join(" ")}`);
});

function shutdown() {
  log("shutting down");
  client.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
