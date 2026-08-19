# Codex setup

Build the checkout before registering it:

```zsh
cd /absolute/path/to/android-agent-mcp
npm run install:guided
```

The guided installer uses the repository lockfile, builds the server, detects Codex when its command is available, and writes the native MCP registration. It does not install system packages, change udev rules, restart ADB, or use elevated privileges. If dependencies are already installed, use `npm run install:guided -- --skip-dependencies`.

The published npm package can configure Codex without a checkout:

```zsh
npx -y android-agent-mcp@0.4.1 setup --client codex
```

For a reusable global installation:

```zsh
npm install --global android-agent-mcp@0.4.1
android-agent-mcp setup --client codex
```

To register a pinned release manually instead, use `npx` as the executable and pass the package invocation as arguments:

```zsh
codex mcp add android-device -- npx --yes android-agent-mcp@0.4.1
```

When working inside an `android-agent-mcp` source checkout, use the compiled local entrypoint below instead of `npx` so npm does not resolve the checkout itself. npm installs the MCP server only; `adb` and `scrcpy` remain host prerequisites.

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
args = ["/absolute/path/to/android-agent-mcp/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

Use an absolute path. If the project has a local configuration file, pass it through the server environment:

```toml
[mcp_servers.android-device.env]
ANDROID_AGENT_MCP_CONFIG = "/absolute/path/to/android-agent-mcp.json"
```

Restart the Codex client after adding or changing an MCP server. Verify the connection with `/mcp` in the Codex TUI or by asking Codex to list the Android Agent MCP tools. The server instructions are intentionally short and begin with device selection, broad non-sensitive package control, secret handling, semantic actions, verification, and visible-mirror rules.

The stable MCP registration name remains `android-device`; the repository and CLI rename does not require existing Codex users to remove and recreate that registration. If the checkout directory changes, update only its absolute `args` path and restart Codex.

## Approval behavior

The server independently enforces approval-required operations through the host-configured `approvalMode`. Mutation tools do not accept a model-supplied `approved` argument: ordinary tool input cannot authorize a destructive operation. The default `prompt` mode is fail-closed because this local server cannot treat model text as user approval. Set `ANDROID_AGENT_MCP_APPROVAL_MODE=allow` only in a deliberately trusted host session, and keep Codex tool approval at `writes` or stricter as an additional client-side control.

## Current official reference

OpenAI’s [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) describes local STDIO servers, shared Codex MCP configuration, `codex mcp add`, `codex mcp list`, and server initialization instructions. Consult it if the installed Codex CLI syntax changes.
