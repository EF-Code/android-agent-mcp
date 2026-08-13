# Codex setup

Build the checkout before registering it:

```zsh
cd /absolute/path/to/scrcpy-mcp
npm run install:local
```

The installer uses the repository lockfile, builds the server, and prints the resolved absolute entrypoint. It does not install system packages, change udev rules, restart ADB, or use elevated privileges. If dependencies are already installed, use `npm run install:local -- --skip-dependencies`.

Register the compiled stdio entrypoint with the Codex CLI:

```zsh
PROJECT_DIR="$(pwd)"
codex mcp add android-device -- node "$PROJECT_DIR/dist/index.js"
codex mcp list
```

The equivalent shared `config.toml` entry is:

```toml
[mcp_servers.android-device]
command = "node"
args = ["/absolute/path/to/scrcpy-mcp/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

Use an absolute path. If the project has a local configuration file, pass it through the server environment:

```toml
[mcp_servers.android-device.env]
ANDROID_DEVICE_MCP_CONFIG = "/absolute/path/to/android-device-mcp.json"
```

Restart the Codex client after adding or changing an MCP server. Verify the connection with `/mcp` in the Codex TUI or by asking Codex to list the Android Device MCP tools. The server instructions are intentionally short and begin with the device-selection, semantic-action, allowlist, secret-handling, and verification rules.

## Approval behavior

The server independently enforces approval-required operations through the host-configured `approvalMode`. Mutation tools do not accept a model-supplied `approved` argument: ordinary tool input cannot authorize a destructive operation. The default `prompt` mode is fail-closed because this local server cannot treat model text as user approval. Set `ANDROID_DEVICE_MCP_APPROVAL_MODE=allow` only in a deliberately trusted host session, and keep Codex tool approval at `writes` or stricter as an additional client-side control.

## Current official reference

OpenAI’s official MCP documentation describes local STDIO servers, shared Codex MCP configuration, `codex mcp add`, `codex mcp list`, and server initialization instructions. Consult it if the installed Codex CLI syntax changes.
