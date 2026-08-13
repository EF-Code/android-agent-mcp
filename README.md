# Android Agent MCP (`android-agent-mcp`)

Android Agent MCP is a local MCP server that enables AI agents to control an explicitly authorized Android phone over ADB, with a visible server-owned scrcpy mirror. It exposes screenshots, UIAutomator state, semantic interaction, package diagnostics, bounded logcat, evidence recording, and reversible phone controls. scrcpy is the live-view subsystem, not the product's control plane.

The server does not call a language model and does not bypass Android locks, authentication, Play Integrity, DRM, root detection, permission prompts, or enterprise policy.

## Status

Implemented and locally verified:

- TypeScript build and strict type-checking
- Automated unit, integration, protocol, and scrcpy tests, plus a separate opt-in physical-device smoke test
- ADB/scrcpy adapters with injectable command runners
- Device discovery, explicit selection, screenshots, UIAutomator parsing, semantic selectors, input, app inspection, logcat, scrcpy ownership, and evidence sessions
- Path-restricted APK installation and approval-gated mutations

Physical-device validation is opt-in and remains a separate gate. The full MCP stdio path has been validated on an authorized Samsung SM-A075F: discovery, selection, device information, visible scrcpy, app launch, screenshot image content, UI dump/find/tap, bounded logcat, evidence completion, and owned-mirror shutdown.

## Requirements

- Linux desktop is the supported initial platform; Manjaro/Arch is the primary tested distribution.
- Node.js 22 or newer.
- Android platform-tools (`adb`).
- `scrcpy` is required by the default visible-mirror workflow; set `ANDROID_AGENT_MCP_MIRROR_AUTO_START=false` for headless operation.
- A phone with Developer Options and USB debugging enabled, with this host’s RSA key accepted.

The server does not install ADB or scrcpy. Verify the host tools without changing system state:

```zsh
adb version
scrcpy --version
adb devices -l
```

The repository also provides a read-only environment check:

```zsh
npm run check:environment
# Add -- --require-scrcpy when mirroring is required.
```

It never installs packages, changes udev rules, restarts ADB, or uses elevated privileges.

## Install from a checkout

```zsh
git clone https://github.com/EF-Code/android-agent-mcp.git
cd android-agent-mcp
npm run install:local
npm run verify
```

`npm run install:local` runs the locked local dependency install, builds the server, and prints the resolved absolute MCP entrypoint and Codex registration command. It does not install system packages, change udev rules, restart ADB, or use elevated privileges. Use `npm run install:local -- --skip-dependencies` when dependencies are already installed; add `--check-environment` to run the read-only ADB/scrcpy preflight during installation.

The executable is then:

```text
/absolute/path/to/android-agent-mcp/dist/index.js
```

Run it directly over stdio:

```zsh
node /absolute/path/to/android-agent-mcp/dist/index.js
```

## Install from npm

Install the published CLI globally:

```zsh
npm install --global android-agent-mcp
command -v android-agent-mcp
```

Then configure your MCP client to launch `android-agent-mcp`. The executable is a stdio server, so it is normally started by the client instead of run interactively.

Alternatively, let an MCP client download a pinned release when it starts the server. Configure the command as `npx` with these arguments:

```json
{
  "command": "npx",
  "args": ["--yes", "android-agent-mcp@0.1.0"]
}
```

Installing from npm provides the MCP server and its Node.js dependencies. It does not install host prerequisites such as `adb` or `scrcpy`; install those with your operating system's documented Android platform-tools and scrcpy packages first. The package runs locally on the computer connected to the authorized phone.

The process reads MCP messages from stdin and writes MCP messages to stdout. Diagnostics go to stderr.

## Codex registration

Resolve the checkout path first, then register the local stdio server:

```zsh
PROJECT_DIR="$(pwd)"
codex mcp add android-device -- node "$PROJECT_DIR/dist/index.js"
codex mcp list
```

The [official OpenAI MCP guidance](https://learn.chatgpt.com/docs/extend/mcp) documents local stdio servers and the same `codex mcp add <name> -- <command>` shape. Restart Codex after registration so the server and its tools are loaded. A project-scoped `.codex/config.toml` can also be used for trusted projects.

## Configuration

Configuration is optional. Without a file, the server enables broad non-sensitive phone control and a visible scrcpy mirror. Select a JSON file with `ANDROID_AGENT_MCP_CONFIG`:

```zsh
ANDROID_AGENT_MCP_CONFIG=/absolute/path/to/android-agent-mcp.json \
  node /absolute/path/to/android-agent-mcp/dist/index.js
```

Example:

```json
{
  "adbPath": "adb",
  "scrcpyPath": "scrcpy",
  "autoSelectSingleDevice": true,
  "allowedPackages": ["*"],
  "sensitivePackages": ["*.bank.*", "*.wallet.*", "*.password*"],
  "allowedRuntimePermissions": [],
  "allowedApkRoots": ["/home/user/projects"],
  "evidenceRoot": "/home/user/android-agent-mcp-evidence",
  "maxScreenshotBytes": 25000000,
  "maxApkBytes": 500000000,
  "maxLogBytes": 2000000,
  "maxCommandOutputBytes": 4000000,
  "maxEvidenceBytes": 100000000,
  "maxEvidenceFiles": 500,
  "evidenceRetentionMaxAgeMs": 604800000,
  "defaultTimeoutMs": 15000,
  "uiSnapshotMaxAgeMs": 3000,
  "approvalMode": "prompt",
  "mirror": {
    "autoStart": true,
    "maxSize": 1600,
    "maxFps": 30,
    "audio": false
  }
}
```

Environment overrides use the `ANDROID_AGENT_MCP_` prefix. The former `ANDROID_MCP_` and `ANDROID_DEVICE_MCP_` variables remain accepted as deprecated compatibility aliases, with canonical variables taking precedence. Lists are comma-separated. Configuration never contains a phone PIN, password, account credential, API key, cookie, or authorization token.

The default `allowedPackages` policy is `*`, so the agent does not require manual app selection. Banking, wallet, and password-style package patterns remain blocked by default; set `ANDROID_AGENT_MCP_SENSITIVE_PACKAGES=''` only for a deliberately trusted session that needs literal all-app control.

## Preferred operating loop

1. Call `device_list`.
2. Call `device_select` when selection is not unambiguous.
3. Call `device_info` and confirm the target.
4. Use `ui_dump`/`ui_find` before coordinate tools.
5. For each action, observe, act, wait briefly, observe again, and report uncertainty.
6. General valid packages are available by default; honor configured sensitive-package blocks.
7. Mutating tools remain fail-closed unless the host explicitly uses `approvalMode: "allow"`; keep Codex write approval enabled as an additional client control.
8. Selecting a device makes one best-effort attempt to start the visible scrcpy mirror unless `mirror.autoStart` is disabled. A scrcpy failure is returned as a warning and never blocks ADB tools. After `mirror_stop`, use `mirror_start` to reopen it explicitly.
9. Use `evidence_begin`, explicitly capture the desired artifacts, then `evidence_finish`.

If the selected phone disconnects or becomes unauthorized, the server invalidates retained UI state and requires an explicit `device_select` again after reconnecting, even when the serial is unchanged.

The server also finalizes an active evidence session during graceful shutdown after cleaning up its owned scrcpy process.

No generic shell tool is exposed.

## Tests

```zsh
npm run typecheck
npm test
npm run build
npm run verify
npm pack --dry-run
npm audit --omit=dev
```

The automated suite uses fake/injectable command boundaries and a child-process MCP client. It does not require a phone and does not install packages or alter device state.

Opt-in physical tests are separate:

```zsh
export ANDROID_AGENT_MCP_PHYSICAL=1
export ANDROID_AGENT_MCP_TEST_PACKAGE=com.example.androiddevicetest
export ANDROID_AGENT_MCP_TEST_SELECTOR='{"text":"7"}'
npm run test:physical
```

The physical harness remains deliberately explicit: it requires a designated test package, a repeatable harmless selector, and exactly one connected authorized phone. It starts the actual stdio MCP server and drives the complete protocol path. This fixture is separate from normal MCP operation, where the default policy permits all valid non-sensitive packages. Destructive tests are not run automatically.

## Tool groups

Read-only tools include `device_list`, `device_info`, `mirror_status`, `screen_capture`, `ui_dump`, `ui_find`, `app_list`, `app_info`, `permissions_list`, `logcat_capture`, and `logcat_crashes`.

Interactive tools include `device_select`, `mirror_start`, `mirror_stop`, `ui_tap`, `screen_tap`, `screen_swipe`, `screen_long_press`, `key_press`, `text_type`, `app_launch`, `app_stop`, and `wait_for_ui`.

Approval-required tools include `app_install`, `app_clear_data`, and `permissions_set`. Evidence tools are local artifact operations with bounded storage and redaction.

## Limitations

- USB ADB and display 0 are the initial supported targets.
- UIAutomator may omit WebViews, games, video, Compose accessibility gaps, and custom canvases; warnings are surfaced.
- Node IDs are snapshot-local and expire after the configured freshness window or a foreground change.
- Default text entry is printable ASCII only and rejects password fields.
- scrcpy audio/control flags are mapped only when supported by the detected version.
- Logcat duration captures are bounded live reads; `since` selects a bounded timestamp dump.
- No wireless pairing, multiple-device parallel control, OCR, continuous video MCP frames, root features, iOS, or remote listener is provided.

See [SECURITY.md](SECURITY.md) and the documents under [docs/](docs/) for operational details.

## Name compatibility

The npm distribution and primary executable are both `android-agent-mcp`. The `android-mcp` and `scrcpy-agent` executables remain deprecated aliases for existing local setups. The MCP server registration name and protocol identity remain `android-device`, so existing Codex MCP configuration does not need to be renamed. Environment precedence is `ANDROID_AGENT_MCP_*`, then deprecated `ANDROID_MCP_*`, then older `ANDROID_DEVICE_MCP_*`.
