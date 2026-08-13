# Configuration reference

The server starts with safe defaults and accepts an optional JSON file selected by `ANDROID_DEVICE_MCP_CONFIG`. Environment variables override file values. Unknown JSON properties and invalid values are rejected.

| JSON field | Environment override | Meaning |
| --- | --- | --- |
| `adbPath` | `ANDROID_DEVICE_MCP_ADB_PATH` | ADB executable path or name |
| `scrcpyPath` | `ANDROID_DEVICE_MCP_SCRCPY_PATH` | scrcpy executable path or name |
| `autoSelectSingleDevice` | `ANDROID_DEVICE_MCP_AUTO_SELECT` | Automatically select exactly one authorized device |
| `allowedPackages` | `ANDROID_DEVICE_MCP_ALLOWED_PACKAGES` | Comma-separated package/glob allowlist |
| `sensitivePackages` | `ANDROID_DEVICE_MCP_SENSITIVE_PACKAGES` | Comma-separated package/glob sensitive patterns |
| `allowedApkRoots` | `ANDROID_DEVICE_MCP_ALLOWED_APK_ROOTS` | Comma-separated absolute host directories |
| `evidenceRoot` | `ANDROID_DEVICE_MCP_EVIDENCE_ROOT` | Absolute evidence directory |
| `maxScreenshotBytes` | `ANDROID_DEVICE_MCP_MAX_SCREENSHOT_BYTES` | Maximum screenshot size |
| `maxApkBytes` | `ANDROID_DEVICE_MCP_MAX_APK_BYTES` | Maximum local APK size |
| `maxLogBytes` | `ANDROID_DEVICE_MCP_MAX_LOG_BYTES` | Maximum log capture size |
| `maxCommandOutputBytes` | `ANDROID_DEVICE_MCP_MAX_COMMAND_OUTPUT_BYTES` | Per-command stdout/stderr limit |
| `maxEvidenceBytes` | `ANDROID_DEVICE_MCP_MAX_EVIDENCE_BYTES` | Evidence session byte budget |
| `maxEvidenceFiles` | `ANDROID_DEVICE_MCP_MAX_EVIDENCE_FILES` | Evidence file budget |
| `evidenceRetentionMaxAgeMs` | `ANDROID_DEVICE_MCP_EVIDENCE_RETENTION_MAX_AGE_MS` | Maximum age of completed evidence directories before safe root-scoped cleanup |
| `defaultTimeoutMs` | `ANDROID_DEVICE_MCP_DEFAULT_TIMEOUT_MS` | Default ADB command timeout |
| `uiSnapshotMaxAgeMs` | `ANDROID_DEVICE_MCP_UI_SNAPSHOT_MAX_AGE_MS` | Semantic snapshot freshness window |
| `approvalMode` | `ANDROID_DEVICE_MCP_APPROVAL_MODE` | Host policy: `prompt` (fail closed), `allow`, or `deny` |

The nested `mirror` object supports `maxSize`, `maxFps`, `audio`, and `leaveRunningOnExit`. Mirror defaults are conservative: audio disabled, screen remains on, and ordinary control remains enabled.

Never put phone PINs, passwords, account credentials, API keys, cookies, or authorization tokens in this file or environment overrides.
