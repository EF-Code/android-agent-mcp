# Android Device MCP (`scrcpy-agent`)

Android Device MCP is a local, security-conscious MCP server for observing and controlling an explicitly authorized Android development phone over USB. It exposes ADB-backed screenshots, UIAutomator state, semantic interaction, package diagnostics, bounded logcat, evidence recording, and an optional server-owned scrcpy mirror.

The server does not call a language model and does not bypass Android locks, authentication, Play Integrity, DRM, root detection, permission prompts, or enterprise policy.

## Status

Implemented and locally verified:

- TypeScript build and strict type-checking
- 23 automated unit and MCP stdio protocol tests
- ADB/scrcpy adapters with injectable command runners
- Device discovery, explicit selection, screenshots, UIAutomator parsing, semantic selectors, input, app inspection, logcat, scrcpy ownership, and evidence sessions
- Path-restricted APK installation and approval-gated mutations

Physical-device validation is opt-in and remains a separate gate. At the latest validation point no USB device was connected. Do not interpret the passing mocked tests as proof of phone behavior.

## Requirements

- Linux desktop is the supported initial platform; Manjaro/Arch is the primary tested distribution.
- Node.js 22 or newer.
- Android platform-tools (`adb`).
- `scrcpy` is optional for headless tools and required only for mirroring.
- A phone with Developer Options and USB debugging enabled, with this host’s RSA key accepted.

The server does not install ADB or scrcpy. Verify the host tools without changing system state:

```zsh
adb version
scrcpy --version
adb devices -l
```

## Install from a checkout

```zsh
git clone https://github.com/EF-Code/scrcpy-mcp.git
cd scrcpy-mcp
npm ci
npm run build
```

The executable is then:

```text
/absolute/path/to/scrcpy-mcp/dist/index.js
```

Run it directly over stdio:

```zsh
node /absolute/path/to/scrcpy-mcp/dist/index.js
```

The process reads MCP messages from stdin and writes MCP messages to stdout. Diagnostics go to stderr.

## Codex registration

Resolve the checkout path first, then register the local stdio server:

```zsh
PROJECT_DIR="$(pwd)"
codex mcp add android-device -- node "$PROJECT_DIR/dist/index.js"
codex mcp list
```

The current official OpenAI MCP guidance documents local stdio servers and the same `codex mcp add <name> -- <command>` shape. Restart Codex after registration so the server and its tools are loaded. A project-scoped `.codex/config.toml` can also be used for trusted projects.

## Configuration

Configuration is optional. Without a file, conservative defaults are used. Select a JSON file with `ANDROID_DEVICE_MCP_CONFIG`:

```zsh
ANDROID_DEVICE_MCP_CONFIG=/absolute/path/to/android-device-mcp.json \
  node /absolute/path/to/scrcpy-mcp/dist/index.js
```

Example:

```json
{
  "adbPath": "adb",
  "scrcpyPath": "scrcpy",
  "autoSelectSingleDevice": true,
  "allowedPackages": ["com.example.test"],
  "sensitivePackages": ["com.android.settings", "*.bank.*", "*.wallet.*"],
  "allowedApkRoots": ["/home/user/projects"],
  "evidenceRoot": "/home/user/android-device-mcp-evidence",
  "maxScreenshotBytes": 25000000,
  "maxApkBytes": 500000000,
  "maxLogBytes": 2000000,
  "maxCommandOutputBytes": 4000000,
  "maxEvidenceBytes": 100000000,
  "maxEvidenceFiles": 500,
  "defaultTimeoutMs": 15000,
  "uiSnapshotMaxAgeMs": 3000,
  "approvalMode": "prompt",
  "mirror": {
    "maxSize": 1600,
    "maxFps": 30,
    "audio": false
  }
}
```

Environment overrides use the `ANDROID_DEVICE_MCP_` prefix. Lists are comma-separated. Configuration never contains a phone PIN, password, account credential, API key, cookie, or authorization token.

## Preferred operating loop

1. Call `device_list`.
2. Call `device_select` when selection is not unambiguous.
3. Call `device_info` and confirm the target.
4. Use `ui_dump`/`ui_find` before coordinate tools.
5. For each action, observe, act, wait briefly, observe again, and report uncertainty.
6. Keep every package inside the configured allowlist.
7. Ask for approval before APK installation, permission changes, clear-data, or other mutating operations.
8. Use `mirror_start` only when the user wants a visible scrcpy window; continue to act through ADB tools.
9. Use `evidence_begin`, explicitly capture the desired artifacts, then `evidence_finish`.

No generic shell tool is exposed.

## Tests

```zsh
npm run typecheck
npm test
npm run build
```

The automated suite uses fake/injectable command boundaries and a child-process MCP client. It does not require a phone and does not install packages or alter device state.

Opt-in physical tests are separate:

```zsh
ANDROID_DEVICE_MCP_PHYSICAL=1 npm run test:physical
```

They require a designated harmless test package and a connected authorized phone. Destructive tests are not run automatically.

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
- No wireless pairing, multiple-device parallel control, OCR, continuous video MCP frames, root features, iOS, or remote listener is provided.

See [SECURITY.md](SECURITY.md) and the documents under [docs/](docs/) for operational details.
