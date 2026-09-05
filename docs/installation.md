# Guided installation

Android Agent MCP includes a guided installer for users who already have one or more MCP-capable agents, harnesses, or developer tools installed.

## Published npm setup

With Node.js 22 or newer and the Android host prerequisites installed, run:

```zsh
npx -y android-agent-mcp@0.5.1 setup
```

The installer checks commands on `PATH`, writes only the detected hosts, and prints the files it configured. A global installation is useful when the setup command will be run more than once:

```zsh
npm install --global android-agent-mcp@0.5.1
android-agent-mcp setup
```

The server itself still needs `adb`; the default visible-mirror workflow also needs `scrcpy`. The installer does not install operating-system packages, change udev rules, restart ADB, or use elevated privileges.

## Source checkout setup

For unreleased changes or local development:

```zsh
git clone https://github.com/EF-Code/android-agent-mcp.git
cd android-agent-mcp
node scripts/install.mjs
```

The source installer runs `npm ci`, builds the server, and invokes the same guided setup implementation used by the npm package. These options are also available through `npm run install:guided`:

```zsh
npm run install:guided -- --skip-dependencies
npm run install:guided -- --check-environment
npm run install:guided -- --client codex
```

`npm run install:local` remains a compatibility alias for the guided source installer.

## Supported hosts

Automatic detection uses host commands, not leftover configuration files. A stale configuration file is not treated as proof that an application is installed. Use `--client NAME` when the host command is not on `PATH`, or use `--client all` when you intentionally want every supported configuration written.

| Host        | Detection command          | Configuration written                                   |
| ----------- | -------------------------- | ------------------------------------------------------- |
| Codex       | `codex`                    | `~/.codex/config.toml`                                  |
| Claude Code | `claude`                   | `~/.claude.json`                                        |
| OpenClaw    | `openclaw`                 | `~/.openclaw/openclaw.json` or the OpenClaw MCP command |
| Antigravity | `antigravity` or `agy`     | `~/.gemini/config/mcp_config.json`                      |
| Gemini CLI  | `gemini`                   | `~/.gemini/settings.json`                               |
| OpenCode    | `opencode`                 | `~/.config/opencode/opencode.json`                      |
| Cursor      | `cursor` or `cursor-agent` | `~/.cursor/mcp.json`                                    |
| Windsurf    | `windsurf`                 | `~/.codeium/windsurf/mcp_config.json`                   |
| VS Code     | `code` or `code-insiders`  | `Code/User/mcp.json`, or `code --add-mcp`               |
| Pi          | `pi`                       | `~/.pi/agent/mcp.json`                                  |
| Cline       | `cline`                    | `~/.cline/data/settings/cline_mcp_settings.json`        |
| Zed         | `zed`                      | `~/.config/zed/settings.json`                           |
| Goose       | `goose`                    | `~/.config/goose/config.yaml`                           |

The documented macOS and Windows application-data roots are selected automatically for hosts whose configuration paths differ by platform. `CLINE_DATA_DIR`, `XDG_CONFIG_HOME`, and `APPDATA` are honored where applicable.

## Preview, target, and generic modes

Preview the native configuration without writing anything:

```zsh
npx -y android-agent-mcp@0.5.1 setup --dry-run
```

Configure one host explicitly:

```zsh
npx -y android-agent-mcp@0.5.1 setup --client openclaw
```

Print a portable JSON configuration for a host not included in the automatic integrations:

```zsh
npx -y android-agent-mcp@0.5.1 setup --client generic
```

Pass a project-specific Android Agent MCP configuration file to the generated host entry:

```zsh
npx -y android-agent-mcp@0.5.1 setup --config /absolute/path/android-agent-mcp.json
```

Existing configuration files are updated in place and retain their current permissions. Before the first update, the installer creates a sibling backup with the suffix `.android-agent-mcp.bak`; later runs do not overwrite that first backup. Writes use temporary files and atomic replacement where the host format permits it.

After setup, restart the configured host. Ask it to list the `android-device` tools, call `device_list`, select the authorized phone, and start the visible mirror before interacting with applications.
