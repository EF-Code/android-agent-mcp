# Security model

Android Device MCP controls a USB-debug-authorized phone. That authorization is powerful and may expose private application state. Run the server only on a trusted workstation and select only a phone intended for development or testing.

## Trust boundaries

- The MCP client/model supplies tool arguments and selectors; it is not trusted with arbitrary command strings.
- The local server validates device serials, package names, paths, coordinates, durations, selectors, output sizes, and evidence labels.
- ADB is the device control plane. Every device command uses `adb -s <validated-serial>`.
- scrcpy is the default visible observation/control plane. Only the child process created by this server is tracked and terminated; set mirror auto-start false for intentional headless operation.
- The phone remains an external system. The server does not unlock it, bypass consent, elevate privileges, or defeat application security controls.

## Controls

- stdio only; no unauthenticated network listener
- subprocess argument arrays with `shell: false`
- bounded command timeouts and stdout/stderr output
- restricted inherited environment for subprocesses
- explicit device selection when automatic single-device selection is not safe
- one selected serial per process session; reconnects do not silently switch devices
- default broad package policy with configurable narrowing and sensitive-package patterns
- empty-by-default host allowlist for runtime permissions that may reach `pm grant/revoke`
- read-only, interactive, approval-required, and prohibited operation classes
- no arbitrary `adb shell(command)` tool
- password UI text redaction and typed-value omission
- common authorization, cookie, token, credential, and email log redaction
- APK roots require absolute paths, realpath containment, regular files, extension, size, and SHA-256 checks
- evidence paths remain below a configured root and use bounded file/byte budgets
- semantic node IDs expire with the UI snapshot

## Sensitive applications

Sensitive packages are blocked from interaction and evidence by default. The default blocks banking, wallet, and password-style package patterns; Android Settings remains available for ordinary device control. Configure the patterns and package policy deliberately when a trusted phone-control session needs a different boundary.

The default text tool supports only printable ASCII test values and rejects focused password fields. It does not install a clipboard or custom ADB keyboard helper.

## Mutations

APK installation, runtime permission changes, and clear-data are fail-closed under the default `prompt` policy. Mutation tools have no model-controlled approval Boolean; only a host-configured `approvalMode=allow` can enable them, with the MCP client's write approval as an additional control. Clear-data removes local application data and is intentionally not automatically used as a repair step. The server never uninstalls an existing package to work around a signature mismatch.

Power, wake, special-access permissions, factory reset, reboot/bootloader, flashing, rooting, certificate installation, security policy changes, SMS, calls, payments, account deletion, token extraction, and arbitrary shell execution are prohibited or unavailable.

## Evidence

Evidence is opt-in, not continuous. Manifests mask device serials and hash the original serial. Actions omit secret values, logs are redacted, UI password text is replaced with `[REDACTED]`, and screenshot/UI/log files are bounded and hashed. Treat the evidence directory as sensitive because screenshots and UI state may still contain developer data that cannot be inferred as secret by pattern matching.

## Reporting

Report security issues privately to the repository owner before public disclosure. Include a minimal reproduction, affected version/commit, environment, and whether a physical phone was involved. Do not include phone credentials, tokens, personal data, or unredacted evidence bundles.
