# cc-grok

`cc-grok` runs Claude Code while routing Anthropic Messages API traffic through a local adapter to a Grok-compatible upstream.

It keeps Claude Code as the runtime and UI, but fixes compatibility gaps commonly seen with Grok proxies:

- normalizes `tools[].input_schema.properties`
- normalizes `tools[].input_schema.required`
- moves `messages[].role === "system"` into top-level `system`
- normalizes streaming content block indexes

## Install Locally

```bash
ln -sf "$PWD/bin/cc-grok" "$HOME/.local/bin/cc-grok"
```

Ensure `~/.local/bin` is in `PATH`.

## Config

The runtime config lives outside the repository:

```txt
~/.config/cc-grok/config.json
```

Create it:

```bash
cc-grok config init
```

Then edit `apiKey`. The default model mapping is:

```json
{
  "models": {
    "main": "grok-4.5-cli",
    "opus": "grok-4.5-cli",
    "sonnet": "grok-composer-2.5-fast-cli",
    "haiku": "grok-composer-2.5-fast-cli"
  }
}
```

Show redacted config:

```bash
cc-grok config show
```

## Usage

Interactive:

```bash
cc-grok
```

Print mode:

```bash
cc-grok -p 'Reply with exactly: pong'
```

## Verification

```bash
npm run check
cc-grok -p 'Reply with exactly: pong'
```
