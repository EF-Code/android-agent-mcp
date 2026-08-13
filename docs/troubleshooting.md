# Troubleshooting

## `adb` is missing

Install Android platform-tools using your distribution’s documented package method, then verify `adb version`. The server does not install packages or modify system paths.

## Device is `unauthorized`

Unlock the phone, inspect the RSA fingerprint, and accept the USB debugging prompt. Do not try to automate the authorization prompt.

## Device is `offline`

Reconnect the USB data cable and inspect `adb devices -l` again. The server does not automatically kill/restart the ADB daemon.

## Device is `no permissions`

Fix the host’s udev rules or user group membership according to the Linux distribution documentation. Do not run the MCP server as root as a workaround.

## More than one phone is connected

Call `device_list`, then `device_select` with the exact serial. Every later command remains bound to that serial.

## A reconnected phone is rejected

After a disconnect or authorization transition, call `device_list` and then `device_select` again, even if the phone reports the same serial. The server intentionally invalidates the previous device session and retained UI snapshots.

## Screenshot or UI dump fails

Check that the device is authorized and unlocked. UIAutomator may be empty or incomplete for WebViews, games, video, Compose accessibility gaps, and custom canvases. Use coordinate fallback only after inspecting the native display dimensions and rotation.

## `scrcpy` is missing

Headless screenshots, UI inspection, ADB control, apps, and logs do not require scrcpy. Install scrcpy only if a visible mirror is wanted, then rerun `scrcpy --version`.

## APK installation fails

Confirm the path is absolute, inside `allowedApkRoots`, a regular `.apk` file, below `maxApkBytes`, and not a symlink escaping the root. Signature mismatch, downgrade, ABI, split, and SDK failures are reported separately. Do not uninstall the existing app automatically.

## MCP tools do not appear in Codex

Run `codex mcp list`, confirm the compiled absolute path, restart Codex, and check `/mcp`. If the server exits, run `node /absolute/path/to/dist/index.js` directly and inspect stderr without sending secrets.

## Physical tests are skipped

The physical suite requires `ANDROID_DEVICE_MCP_PHYSICAL=1`, a connected authorized device, an explicit allowlisted harmless test package, and known test semantics. A missing phone is a pending hardware gate, not a passing result.
