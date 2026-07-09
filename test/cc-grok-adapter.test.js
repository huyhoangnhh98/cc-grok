const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { spawn } = require("node:child_process");

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createUpstream(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function waitForAdapter(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find((entry) => entry.includes("CC_GROK_ADAPTER_READY"));
      if (line) {
        resolve(JSON.parse(line.slice(line.indexOf("{"))).baseUrl);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      reject(new Error(`adapter exited before ready with code ${code}: ${stderr}`));
    });
  });
}

async function startAdapter(upstream) {
  const upstreamPort = upstream.address().port;
  const child = spawn(process.execPath, ["lib/cc-grok-adapter.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CC_GROK_API_KEY: "test-key",
      CC_GROK_UPSTREAM_BASE: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = await waitForAdapter(child);
  return { child, baseUrl };
}

function stopAdapter(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

function readSseEvents(text) {
  return text
    .trim()
    .split(/\n\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      return data ? JSON.parse(data) : null;
    })
    .filter(Boolean);
}

function messagesRequestBody(model = "test-model") {
  return {
    model,
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "read the README" }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            offset: { type: "integer" },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function bashMessagesRequestBody() {
  return {
    model: "test-model",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "inspect files" }],
    tools: [
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string" },
            description: { type: "string" },
            timeout: { type: "integer" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    ],
  };
}

test("normalizes streamed tool_use input against the request tool schema", async () => {
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "test-model",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_test", name: "Read", input: {} },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\",\"extra\":true,\"offset\":\"2\"}" },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messagesRequestBody()),
    });
    const events = readSseEvents(await response.text());
    const inputDelta = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");

    assert.deepEqual(JSON.parse(inputDelta.delta.partial_json), { file_path: "README.md", offset: 2 });
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("unwraps nested JSON strings inside Bash command input", async () => {
  const shellCommand = "which agy; which opencode; ls apps/BE/app/";
  const concatenatedToolPayload =
    JSON.stringify({ command: shellCommand, description: "Check tools and read architecture docs" }) +
    JSON.stringify({ description: "Scout BE backend structure", prompt: "Scout apps/BE", subagent_type: "Explore" }) +
    JSON.stringify({ description: "Scout FE frontend structure", prompt: "Scout apps/FE", subagent_type: "Explore" });
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "test-model",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_test", name: "Bash", input: {} },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ command: concatenatedToolPayload }),
      },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bashMessagesRequestBody()),
    });
    const events = readSseEvents(await response.text());
    const inputDelta = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");

    assert.deepEqual(JSON.parse(inputDelta.delta.partial_json), { command: shellCommand });
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("extracts matching properties from concatenated JSON tool payloads", async () => {
  const filePath = "/Users/macos/.claude/skills/scout/references/internal-scouting.md";
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "test-model",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_test", name: "Read", input: {} },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          file_path:
            JSON.stringify({ file_path: filePath }) +
            JSON.stringify({ file_path: "/Users/macos/.claude/.ck.json" }) +
            JSON.stringify({ command: "ls -la /Users/macos/Desktop/source/finops/code-commit-finops" }),
        }),
      },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messagesRequestBody()),
    });
    const events = readSseEvents(await response.text());
    const inputDelta = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");

    assert.deepEqual(JSON.parse(inputDelta.delta.partial_json), { file_path: filePath });
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("keeps first values from raw concatenated JSON tool payloads", async () => {
  const firstCommand = "which agy; which opencode";
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "test-model",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_test", name: "Bash", input: {} },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json:
          JSON.stringify({ command: firstCommand, description: "Check tools" }) +
          JSON.stringify({ command: "echo wrong", description: "Scout BE", prompt: "Scout apps/BE" }),
      },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bashMessagesRequestBody()),
    });
    const events = readSseEvents(await response.text());
    const inputDelta = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");

    assert.deepEqual(JSON.parse(inputDelta.delta.partial_json), { command: firstCommand, description: "Check tools" });
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("leaves non-sequence command strings intact", async () => {
  const command = "{\"command\":\"echo wrong\"} && echo real";
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "test-model",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_test", name: "Bash", input: {} },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bashMessagesRequestBody()),
    });
    const events = readSseEvents(await response.text());
    const inputDelta = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");

    assert.deepEqual(JSON.parse(inputDelta.delta.partial_json), { command });
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("scales Grok usage tokens so Claude Code context percentage uses the real window", async () => {
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "grok-4.5-cli",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 250000, output_tokens: 0 },
      },
    });
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1000 },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messagesRequestBody("grok-4.5-cli")),
    });
    const events = readSseEvents(await response.text());
    const messageStart = events.find((event) => event.type === "message_start");
    const messageDelta = events.find((event) => event.type === "message_delta");

    assert.equal(messageStart.message.usage.input_tokens, 100000);
    assert.equal(messageDelta.usage.output_tokens, 400);
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("normalizes JSON tool_use input objects and JSON strings", async () => {
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [
          {
            type: "tool_use",
            id: "toolu_test",
            name: "Read",
            input: { arguments: "{\"path\":\"README.md\",\"extra\":true}" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const body = messagesRequestBody();
    body.stream = false;
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    assert.deepEqual(data.content[0].input, { file_path: "README.md" });
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});

test("adds Grok context window metadata to models responses", async () => {
  const upstream = await createUpstream(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "grok-4.5-cli", type: "model" },
          { id: "grok-composer-2.5-fast-cli", type: "model" },
        ],
      })
    );
  });
  const { child, baseUrl } = await startAdapter(upstream);

  try {
    const response = await fetch(`${baseUrl}/v1/models`);
    const data = await response.json();

    assert.equal(data.data[0].context_window, 500000);
    assert.equal(data.data[0].context_length, 500000);
    assert.equal(data.data[0].max_context_tokens, 500000);
    assert.equal(data.data[1].context_window, 200000);
  } finally {
    await stopAdapter(child);
    await closeServer(upstream);
  }
});
