#!/usr/bin/env node

const http = require("http");
const { URL } = require("url");

const host = process.env.CC_GROK_HOST || "127.0.0.1";
const port = Number(process.env.CC_GROK_PORT || 0);
const upstreamBase = (process.env.CC_GROK_UPSTREAM_BASE || "https://grok-worker.lploc94.workers.dev").replace(/\/+$/, "");
const upstreamApiKey =
  process.env.CC_GROK_API_KEY ||
  process.env.GROK_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  "";

if (!upstreamApiKey) {
  console.error("cc-grok adapter: missing GROK_API_KEY or CC_GROK_API_KEY");
  process.exit(2);
}

function normalizeTools(body) {
  if (!body || !Array.isArray(body.tools)) return body;

  for (const tool of body.tools) {
    const schema = tool && tool.input_schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;

    if (schema.type === "object") {
      if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
        schema.properties = {};
      }
      if (!Array.isArray(schema.required)) {
        schema.required = [];
      }
    }
  }

  return body;
}

function toTextBlocks(content) {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];

  return content.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (part && part.type === "text" && typeof part.text === "string") return part;
    if (part && typeof part.text === "string") return { type: "text", text: part.text };
    return { type: "text", text: JSON.stringify(part) };
  });
}

function normalizeSystemMessages(body) {
  if (!body || !Array.isArray(body.messages)) return body;

  const systemBlocks = [];
  const messages = [];

  for (const message of body.messages) {
    if (message && message.role === "system") {
      systemBlocks.push(...toTextBlocks(message.content));
    } else {
      messages.push(message);
    }
  }

  if (systemBlocks.length === 0) return body;

  const existingSystem = toTextBlocks(body.system);
  body.system = [...existingSystem, ...systemBlocks];
  body.messages = messages;
  return body;
}

function normalizeRequestBody(rawBody) {
  if (!rawBody) return rawBody;

  const body = JSON.parse(rawBody);
  normalizeSystemMessages(body);
  normalizeTools(body);
  return JSON.stringify(body);
}

function stripHopByHopHeaders(headers) {
  const next = { ...headers };
  for (const key of [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete next[key];
  }
  return next;
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function normalizeSseEvent(state, parsed) {
  if (!parsed || parsed.data === "[DONE]") return null;

  let data;
  try {
    data = JSON.parse(parsed.data);
  } catch {
    return parsed;
  }

  if (data && data.type === "content_block_start") {
    state.currentContentBlockIndex = state.nextContentBlockIndex;
    data.index = state.currentContentBlockIndex;
    state.nextContentBlockIndex += 1;
  } else if (data && data.type === "content_block_delta") {
    data.index = typeof state.currentContentBlockIndex === "number" ? state.currentContentBlockIndex : data.index || 0;
  } else if (data && data.type === "content_block_stop") {
    data.index = typeof state.currentContentBlockIndex === "number" ? state.currentContentBlockIndex : data.index || 0;
    state.currentContentBlockIndex = null;
  }

  return { event: parsed.event, data };
}

async function pipeNormalizedSse(upstreamResponse, res) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = { nextContentBlockIndex: 0, currentContentBlockIndex: null };
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const normalized = normalizeSseEvent(state, parseSseBlock(block));
      if (!normalized) continue;

      if (typeof normalized.data === "string") {
        if (normalized.event) res.write(`event: ${normalized.event}\n`);
        res.write(`data: ${normalized.data}\n\n`);
      } else {
        writeSse(res, normalized.event, normalized.data);
      }
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const normalized = normalizeSseEvent(state, parseSseBlock(tail));
    if (normalized) {
      if (typeof normalized.data === "string") {
        if (normalized.event) res.write(`event: ${normalized.event}\n`);
        res.write(`data: ${normalized.data}\n\n`);
      } else {
        writeSse(res, normalized.event, normalized.data);
      }
    }
  }

  res.end();
}

async function proxy(req, res) {
  if (req.method === "HEAD" && req.url === "/") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    writeJson(res, 200, { ok: true, upstream: upstreamBase });
    return;
  }

  const incomingUrl = new URL(req.url, `http://${host}`);
  let path = incomingUrl.pathname;
  if (!path.startsWith("/v1/")) {
    path = `/v1${path.startsWith("/") ? "" : "/"}${path}`;
  }

  const upstreamUrl = new URL(`${upstreamBase}${path}${incomingUrl.search}`);
  const rawBody = await readRequest(req);
  let body = rawBody;

  if (rawBody && req.headers["content-type"] && req.headers["content-type"].includes("application/json")) {
    try {
      body = normalizeRequestBody(rawBody);
    } catch (error) {
      writeJson(res, 400, { error: `cc-grok adapter could not parse JSON request: ${error.message}` });
      return;
    }
  }

  const headers = stripHopByHopHeaders(req.headers);
  headers.authorization = `Bearer ${upstreamApiKey}`;
  delete headers["x-api-key"];
  if (body) {
    headers["content-length"] = Buffer.byteLength(body);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: body || undefined,
      redirect: "manual",
    });
  } catch (error) {
    writeJson(res, 502, { error: `cc-grok adapter upstream request failed: ${error.message}` });
    return;
  }

  const responseHeaders = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (!["connection", "content-encoding", "content-length", "keep-alive", "transfer-encoding"].includes(key)) {
      responseHeaders[key] = value;
    }
  });

  res.writeHead(upstreamResponse.status, responseHeaders);
  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    await pipeNormalizedSse(upstreamResponse, res);
    return;
  }

  const reader = upstreamResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}

const server = http.createServer((req, res) => {
  proxy(req, res).catch((error) => {
    writeJson(res, 500, { error: `cc-grok adapter error: ${error.message}` });
  });
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const readyPayload = JSON.stringify({ host, port: actualPort, baseUrl: `http://${host}:${actualPort}` });
  console.log(`CC_GROK_ADAPTER_READY ${readyPayload}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(130)));
