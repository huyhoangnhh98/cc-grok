#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const defaults = {
  upstreamBase: "https://grok-worker.lploc94.workers.dev",
  apiKey: "",
  models: {
    main: "grok-4.5-cli",
    opus: "grok-4.5-cli",
    sonnet: "grok-composer-2.5-fast-cli",
    haiku: "grok-composer-2.5-fast-cli",
  },
};

function usage() {
  console.error("usage: cc-grok-config.js <shell|show|init|path> <config-path>");
  process.exit(2);
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { ...defaults, missing: true };
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    upstreamBase: parsed.upstreamBase || defaults.upstreamBase,
    apiKey: parsed.apiKey || process.env.CC_GROK_API_KEY || process.env.GROK_API_KEY || "",
    models: {
      main: parsed.models?.main || defaults.models.main,
      opus: parsed.models?.opus || defaults.models.opus,
      sonnet: parsed.models?.sonnet || defaults.models.sonnet,
      haiku: parsed.models?.haiku || defaults.models.haiku,
    },
    missing: false,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function redactConfig(config) {
  return {
    upstreamBase: config.upstreamBase,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 7)}...${config.apiKey.slice(-4)}` : "",
    models: config.models,
  };
}

function initConfig(configPath) {
  if (fs.existsSync(configPath)) {
    console.error(`cc-grok: config already exists: ${configPath}`);
    process.exit(1);
  }

  const config = {
    ...defaults,
    apiKey: process.env.CC_GROK_API_KEY || process.env.GROK_API_KEY || "",
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  console.log(configPath);
}

const [command, configPath] = process.argv.slice(2);
if (!command || !configPath) usage();

if (command === "path") {
  console.log(configPath);
  process.exit(0);
}

if (command === "init") {
  initConfig(configPath);
  process.exit(0);
}

let config;
try {
  config = readConfig(configPath);
} catch (error) {
  console.error(`cc-grok: failed to read config ${configPath}: ${error.message}`);
  process.exit(1);
}

if (command === "show") {
  console.log(JSON.stringify(redactConfig(config), null, 2));
  process.exit(0);
}

if (command !== "shell") usage();

if (config.missing) {
  console.error(`cc-grok: config not found: ${configPath}`);
  console.error("cc-grok: run `cc-grok config init`, then add apiKey");
  process.exit(1);
}

if (!config.apiKey) {
  console.error(`cc-grok: missing apiKey in ${configPath}`);
  process.exit(2);
}

console.log(`export CC_GROK_UPSTREAM_BASE=${shellQuote(config.upstreamBase)}`);
console.log(`export CC_GROK_API_KEY=${shellQuote(config.apiKey)}`);
console.log(`export ANTHROPIC_AUTH_TOKEN=${shellQuote(config.apiKey)}`);
console.log(`export ANTHROPIC_MODEL=${shellQuote(config.models.main)}`);
console.log(`export ANTHROPIC_DEFAULT_OPUS_MODEL=${shellQuote(config.models.opus)}`);
console.log(`export ANTHROPIC_DEFAULT_SONNET_MODEL=${shellQuote(config.models.sonnet)}`);
console.log(`export ANTHROPIC_DEFAULT_HAIKU_MODEL=${shellQuote(config.models.haiku)}`);
