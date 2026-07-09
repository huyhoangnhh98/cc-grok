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
const rawClaudeCodeDefaultContextWindow = Number(process.env.CC_GROK_CLAUDE_CONTEXT_WINDOW || 200000);
const claudeCodeDefaultContextWindow =
  Number.isFinite(rawClaudeCodeDefaultContextWindow) && rawClaudeCodeDefaultContextWindow > 0
    ? rawClaudeCodeDefaultContextWindow
    : 200000;
const defaultContextWindows = {
  "grok-4.20-0309-non-reasoning": 1000000,
  "grok-4.20-0309-reasoning": 1000000,
  "grok-4.20-multi-agent-0309": 1000000,
  "grok-4.3": 1000000,
  "grok-4.5": 500000,
  "grok-4.5-cli": 500000,
  "grok-build-0.1": 256000,
  "grok-composer-2.5-fast-cli": 200000,
  "grok-imagine-image": 8000,
  "grok-imagine-image-quality": 8000,
};
const contextWindows = parseContextWindows(process.env.CC_GROK_CONTEXT_WINDOWS);

if (!upstreamApiKey) {
  console.error("cc-grok adapter: missing GROK_API_KEY or CC_GROK_API_KEY");
  process.exit(2);
}

function parseContextWindows(raw) {
  if (!raw) return defaultContextWindows;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultContextWindows;

    const normalized = { ...defaultContextWindows };
    for (const [model, value] of Object.entries(parsed)) {
      const contextWindow = Number(value);
      if (model && Number.isFinite(contextWindow) && contextWindow > 0) {
        normalized[model] = contextWindow;
      }
    }
    return normalized;
  } catch {
    return defaultContextWindows;
  }
}

function numericContextWindow(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getModelContextWindow(model, metadata) {
  if (metadata && typeof metadata === "object") {
    for (const key of ["context_window", "context_length", "max_context_tokens", "max_context", "max_input_tokens"]) {
      const contextWindow = numericContextWindow(metadata[key]);
      if (contextWindow) return contextWindow;
    }
  }

  if (typeof model !== "string") return null;
  if (contextWindows[model]) return contextWindows[model];

  const withoutCli = model.replace(/-cli$/, "");
  if (contextWindows[withoutCli]) return contextWindows[withoutCli];

  return null;
}

function contextUsageScale(model) {
  const contextWindow = getModelContextWindow(model);
  if (!contextWindow || contextWindow <= claudeCodeDefaultContextWindow) return 1;
  return claudeCodeDefaultContextWindow / contextWindow;
}

function scaleTokenCount(value, scale) {
  if (scale === 1 || !Number.isFinite(value) || value <= 0) return value;
  return Math.max(1, Math.round(value * scale));
}

function scaleUsageTokens(value, scale) {
  if (scale === 1 || !value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (const item of value) scaleUsageTokens(item, scale);
    return value;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "number" && /tokens$/i.test(key)) {
      value[key] = scaleTokenCount(child, scale);
    } else if (child && typeof child === "object") {
      scaleUsageTokens(child, scale);
    }
  }

  return value;
}

function normalizeModelMetadata(value) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeModelMetadata(item);
    return value;
  }

  if (!value || typeof value !== "object") return value;

  const model = value.id || value.name || value.model;
  const contextWindow = getModelContextWindow(model, value);
  if (contextWindow) {
    value.context_window = contextWindow;
    value.context_length = contextWindow;
    value.max_context_tokens = contextWindow;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") normalizeModelMetadata(child);
  }

  return value;
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

function collectToolSchemas(body) {
  const schemas = new Map();
  if (!body || !Array.isArray(body.tools)) return schemas;

  for (const tool of body.tools) {
    if (tool && typeof tool.name === "string" && tool.input_schema && typeof tool.input_schema === "object") {
      schemas.set(tool.name, tool.input_schema);
    }
  }

  return schemas;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonish(value) {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return {};
  if (!["{", "["].includes(trimmed[0])) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function schemaTypes(schema) {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.anyOf)) return schema.anyOf.flatMap(schemaTypes);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.flatMap(schemaTypes);
  return [];
}

function normalizeKeyName(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function aliasForProperty(key, properties) {
  if (Object.prototype.hasOwnProperty.call(properties, key)) return key;

  const candidates = new Set([toSnakeCase(key), normalizeKeyName(key)]);
  const aliases = {
    command: ["cmd", "shell", "shell_command", "bash", "script"],
    description: ["desc"],
    file_path: ["path", "file", "filepath", "filename", "fileName"],
    new_string: ["new", "newString", "replacement", "replace"],
    old_string: ["old", "oldString", "search", "find"],
    pattern: ["regex", "query", "search"],
    url: ["uri", "link"],
  };

  for (const [property, names] of Object.entries(aliases)) {
    if (Object.prototype.hasOwnProperty.call(properties, property) && names.includes(key)) return property;
  }

  for (const property of Object.keys(properties)) {
    if (candidates.has(property) || candidates.has(normalizeKeyName(property))) return property;
  }

  return null;
}

function coerceValueForSchema(value, schema) {
  const parsed = parseJsonish(value);
  const types = schemaTypes(schema);

  if (types.includes("object") && typeof parsed === "string") {
    return parsed;
  }

  if (types.includes("array") && !Array.isArray(parsed)) {
    return [parsed];
  }

  if (types.includes("boolean") && typeof parsed === "string") {
    if (parsed.toLowerCase() === "true") return true;
    if (parsed.toLowerCase() === "false") return false;
  }

  if ((types.includes("number") || types.includes("integer")) && typeof parsed === "string" && parsed.trim() !== "") {
    const number = Number(parsed);
    if (Number.isFinite(number)) return types.includes("integer") ? Math.trunc(number) : number;
  }

  return parsed;
}

function unwrapToolInput(input) {
  let next = parseJsonish(input);
  if (next === null || next === undefined || next === "") return {};

  if (isPlainObject(next)) {
    const keys = Object.keys(next);
    if (keys.length === 1 && ["arguments", "args", "input", "parameters"].includes(keys[0])) {
      next = parseJsonish(next[keys[0]]);
    }
  }

  return next;
}

function singleRequiredProperty(schema) {
  if (!schema || !Array.isArray(schema.required) || schema.required.length !== 1) return null;
  const property = schema.required[0];
  if (!schema.properties || Object.prototype.hasOwnProperty.call(schema.properties, property)) return property;
  return null;
}

function normalizeToolUseInput(toolName, input, toolSchemas) {
  const schema = toolSchemas instanceof Map ? toolSchemas.get(toolName) : null;
  let next = unwrapToolInput(input);

  if (!isPlainObject(next)) {
    const property = singleRequiredProperty(schema);
    next = property ? { [property]: next } : {};
  }

  const properties = schema && isPlainObject(schema.properties) ? schema.properties : null;
  if (!properties) return next;

  const normalized = {};
  const keepUnknown = schema.additionalProperties !== false;

  for (const [key, value] of Object.entries(next)) {
    const target = aliasForProperty(key, properties);
    if (target) {
      normalized[target] = coerceValueForSchema(value, properties[target]);
    } else if (keepUnknown) {
      normalized[key] = value;
    }
  }

  return normalized;
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

function flushBufferedToolBlock(state, stopEvent, stopData) {
  if (!state.bufferedToolBlock) return [];

  const buffered = state.bufferedToolBlock;
  state.bufferedToolBlock = null;

  const contentBlock = { ...buffered.contentBlock };
  const rawInput = buffered.partialJson ? buffered.partialJson : contentBlock.input;
  const input = normalizeToolUseInput(contentBlock.name, rawInput, state.toolSchemas);
  const startData = {
    ...buffered.startData,
    content_block: {
      ...contentBlock,
      input: {},
    },
  };
  const events = [{ event: buffered.startEvent, data: startData }];

  if (Object.keys(input).length > 0) {
    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: startData.index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input),
        },
      },
    });
  }

  events.push({
    event: stopEvent || "content_block_stop",
    data: stopData || { type: "content_block_stop", index: startData.index },
  });

  return events;
}

function normalizeSseEvent(state, parsed) {
  if (!parsed || parsed.data === "[DONE]") return [];

  let data;
  try {
    data = JSON.parse(parsed.data);
  } catch {
    return [{ event: parsed.event, data: parsed.data }];
  }

  if (data && data.message && data.message.usage) {
    scaleUsageTokens(data.message.usage, state.usageScale);
  }

  if (data && data.type === "content_block_start") {
    state.currentContentBlockIndex = state.nextContentBlockIndex;
    data.index = state.currentContentBlockIndex;
    state.nextContentBlockIndex += 1;
    if (data.content_block && data.content_block.type === "tool_use") {
      state.bufferedToolBlock = {
        startEvent: parsed.event,
        startData: data,
        contentBlock: data.content_block,
        partialJson: "",
      };
      return [];
    }
  } else if (data && data.type === "content_block_delta") {
    data.index = typeof state.currentContentBlockIndex === "number" ? state.currentContentBlockIndex : data.index || 0;
    if (state.bufferedToolBlock && data.index === state.bufferedToolBlock.startData.index) {
      if (data.delta && data.delta.type === "input_json_delta") {
        const partialJson = data.delta.partial_json;
        state.bufferedToolBlock.partialJson += typeof partialJson === "string" ? partialJson : JSON.stringify(partialJson || "");
      }
      return [];
    }
  } else if (data && data.type === "content_block_stop") {
    data.index = typeof state.currentContentBlockIndex === "number" ? state.currentContentBlockIndex : data.index || 0;
    if (state.bufferedToolBlock && data.index === state.bufferedToolBlock.startData.index) {
      const events = flushBufferedToolBlock(state, parsed.event, data);
      state.currentContentBlockIndex = null;
      return events;
    }
    state.currentContentBlockIndex = null;
  } else if (data && data.usage) {
    scaleUsageTokens(data.usage, state.usageScale);
  }

  return [{ event: parsed.event, data }];
}

function writeNormalizedSseEvents(res, normalizedEvents) {
  for (const normalized of normalizedEvents) {
    if (typeof normalized.data === "string") {
      if (normalized.event) res.write(`event: ${normalized.event}\n`);
      res.write(`data: ${normalized.data}\n\n`);
    } else {
      writeSse(res, normalized.event, normalized.data);
    }
  }
}

async function pipeNormalizedSse(upstreamResponse, res, toolSchemas, usageScale) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = { nextContentBlockIndex: 0, currentContentBlockIndex: null, toolSchemas, bufferedToolBlock: null, usageScale };
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

      writeNormalizedSseEvents(res, normalizeSseEvent(state, parseSseBlock(block)));
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const normalized = normalizeSseEvent(state, parseSseBlock(tail));
    writeNormalizedSseEvents(res, normalized);
  }

  writeNormalizedSseEvents(res, flushBufferedToolBlock(state));
  res.end();
}

function normalizeJsonToolUses(value, toolSchemas, usageScale) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeJsonToolUses(item, toolSchemas, usageScale);
    return value;
  }

  if (!isPlainObject(value)) return value;

  if (value.type === "tool_use" && typeof value.name === "string") {
    value.input = normalizeToolUseInput(value.name, value.input, toolSchemas);
  }

  if (value.usage && isPlainObject(value.usage)) {
    scaleUsageTokens(value.usage, usageScale);
  }

  for (const item of Object.values(value)) normalizeJsonToolUses(item, toolSchemas, usageScale);
  return value;
}

async function pipeNormalizedJson(upstreamResponse, res, toolSchemas, usageScale, normalizeModels) {
  const text = await upstreamResponse.text();
  let payload = text;

  try {
    const parsed = JSON.parse(text);
    normalizeJsonToolUses(parsed, toolSchemas, usageScale);
    if (normalizeModels) normalizeModelMetadata(parsed);
    payload = JSON.stringify(parsed);
  } catch {
    payload = text;
  }

  res.end(payload);
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
  let parsedRequestBody = null;

  if (rawBody && req.headers["content-type"] && req.headers["content-type"].includes("application/json")) {
    try {
      body = normalizeRequestBody(rawBody);
      parsedRequestBody = JSON.parse(body);
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

  if (!upstreamResponse.body) {
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end();
    return;
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const toolSchemas = collectToolSchemas(parsedRequestBody);
  const usageScale = contextUsageScale(parsedRequestBody && parsedRequestBody.model);
  const isModelsRequest = req.method === "GET" && path === "/v1/models";
  if (contentType.includes("text/event-stream")) {
    res.writeHead(upstreamResponse.status, responseHeaders);
    await pipeNormalizedSse(upstreamResponse, res, toolSchemas, usageScale);
    return;
  }

  if (contentType.includes("application/json")) {
    res.writeHead(upstreamResponse.status, responseHeaders);
    await pipeNormalizedJson(upstreamResponse, res, toolSchemas, usageScale, isModelsRequest);
    return;
  }

  res.writeHead(upstreamResponse.status, responseHeaders);
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
