# Compatibility and release limits

## Initial target

- Linux desktop, with Manjaro/Arch as the primary tested distribution
- Node.js 22+
- Android platform-tools and USB ADB
- Android 8+ is the reasonable initial compatibility target
- scrcpy versions with the detected flags supported by the installed release
- One device selected per server process
- Display 0 and native device-pixel coordinates

## Known behavior differences

- Android vendors format `dumpsys` output differently. Device properties, battery, lock state, and foreground activity are best-effort normalized and may return `null`/`unknown`.
- UIAutomator does not describe every rendered surface. Warnings identify likely incomplete classes and invalid/missing bounds.
- Android API level, OEM keyboard behavior, Unicode input support, permission policy, and package-manager error strings vary by device.
- scrcpy capability flags are detected from the installed version before launch; unsupported requested options fail instead of being silently approximated.
- Physical test results require the exact phone, USB transport, installed app, and host environment used for the run.

## Rename compatibility

- The canonical project, npm package, and CLI are `android-agent-mcp`, `@ef-code/android-agent-mcp`, and `android-agent-mcp`.
- The former `android-mcp` and `scrcpy-agent` executables remain available as deprecated aliases during the 0.x migration.
- Configuration precedence is `ANDROID_AGENT_MCP_*`, then deprecated `ANDROID_MCP_*`, then older `ANDROID_DEVICE_MCP_*`.
- The MCP registration and protocol identity remain `android-device`, so existing client registrations only need an updated executable path when the checkout moves.
- Fresh installations use `~/android-agent-mcp-evidence`; explicitly configured or existing evidence directories are not moved automatically.

## Not in version 1

Wireless pairing, multiple-device parallel control, remote network transport, iOS, root-only functions, locked-device operation, OCR, continuous video through MCP, accessibility-service installation, Appium replacement, and automated interaction with financial or authentication applications.
