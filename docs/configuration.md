# Configuration reference

The server starts with broad non-sensitive phone-control defaults and accepts an optional JSON file selected by `ANDROID_DEVICE_MCP_CONFIG`. Environment variables override file values. Unknown JSON properties and invalid values are rejected.

| JSON field                  | Environment override                               | Meaning                                                                       |
| --------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `adbPath`                   | `ANDROID_DEVICE_MCP_ADB_PATH`                      | ADB executable path or name                                                   |
| `scrcpyPath`                | `ANDROID_DEVICE_MCP_SCRCPY_PATH`                   | scrcpy executable path or name                                                |
| `autoSelectSingleDevice`    | `ANDROID_DEVICE_MCP_AUTO_SELECT`                   | Automatically select exactly one authorized device                            |
| `allowedPackages`           | `ANDROID_DEVICE_MCP_ALLOWED_PACKAGES`              | Comma-separated package/glob policy; default `*`                              |
| `sensitivePackages`         | `ANDROID_DEVICE_MCP_SENSITIVE_PACKAGES`            | Comma-separated package/glob sensitive patterns                               |
| `allowedRuntimePermissions` | `ANDROID_DEVICE_MCP_ALLOWED_RUNTIME_PERMISSIONS`   | Host-configured narrow allowlist for `pm grant/revoke`; defaults to empty     |
| `allowedApkRoots`           | `ANDROID_DEVICE_MCP_ALLOWED_APK_ROOTS`             | Comma-separated absolute host directories                                     |
| `evidenceRoot`              | `ANDROID_DEVICE_MCP_EVIDENCE_ROOT`                 | Absolute evidence directory                                                   |
| `maxScreenshotBytes`        | `ANDROID_DEVICE_MCP_MAX_SCREENSHOT_BYTES`          | Maximum screenshot size                                                       |
| `maxApkBytes`               | `ANDROID_DEVICE_MCP_MAX_APK_BYTES`                 | Maximum local APK size                                                        |
| `maxLogBytes`               | `ANDROID_DEVICE_MCP_MAX_LOG_BYTES`                 | Maximum log capture size                                                      |
| `maxCommandOutputBytes`     | `ANDROID_DEVICE_MCP_MAX_COMMAND_OUTPUT_BYTES`      | Per-command stdout/stderr limit                                               |
| `maxEvidenceBytes`          | `ANDROID_DEVICE_MCP_MAX_EVIDENCE_BYTES`            | Evidence session byte budget                                                  |
| `maxEvidenceFiles`          | `ANDROID_DEVICE_MCP_MAX_EVIDENCE_FILES`            | Evidence file budget                                                          |
| `evidenceRetentionMaxAgeMs` | `ANDROID_DEVICE_MCP_EVIDENCE_RETENTION_MAX_AGE_MS` | Maximum age of completed evidence directories before safe root-scoped cleanup |
| `defaultTimeoutMs`          | `ANDROID_DEVICE_MCP_DEFAULT_TIMEOUT_MS`            | Default ADB command timeout                                                   |
| `uiSnapshotMaxAgeMs`        | `ANDROID_DEVICE_MCP_UI_SNAPSHOT_MAX_AGE_MS`        | Semantic snapshot freshness window                                            |
| `approvalMode`              | `ANDROID_DEVICE_MCP_APPROVAL_MODE`                 | Host policy: `prompt` (fail closed), `allow`, or `deny`                       |
| `mirror.autoStart`          | `ANDROID_DEVICE_MCP_MIRROR_AUTO_START`             | Start a visible scrcpy mirror after device selection; default `true`          |

The nested `mirror` object supports `autoStart`, `maxSize`, `maxFps`, `audio`, and `leaveRunningOnExit`. The default starts a visible controllable mirror after selection, with audio disabled, screen remaining on, and no stay-awake request. Set `ANDROID_DEVICE_MCP_MIRROR_AUTO_START=false` for headless operation.

The default `allowedPackages` value is `*`, so ordinary installed applications do not require manual package selection. The default `sensitivePackages` list blocks banking, wallet, and password-style package patterns. For a deliberately trusted session that must include those packages, set `ANDROID_DEVICE_MCP_SENSITIVE_PACKAGES` to an empty value and keep the host under direct supervision.

`logcat_capture.duration_ms` runs a bounded live logcat capture for that duration. `logcat_capture.since` uses a bounded dump from the supplied logcat timestamp instead; the two modes are mutually exclusive in effect, with `since` taking precedence.

Never put phone PINs, passwords, account credentials, API keys, cookies, or authorization tokens in this file or environment overrides.
