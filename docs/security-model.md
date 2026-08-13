# Security model quick reference

| Class | Examples | Default behavior |
| --- | --- | --- |
| Read-only | Device list/info, screenshot, UI dump/find, package list/info, permissions list, logcat, mirror status | Allowed after device discovery; package-sensitive data remains filtered/redacted |
| Interactive/reversible | Semantic tap, coordinate input, swipe, long press, allowlisted app launch/stop, safe test text, owned scrcpy start/stop | Requires selected device and policy checks |
| Approval-required/mutating | APK install, runtime permission grant/revoke, clear application data | Requires policy approval and package/path validation |
| Prohibited | Generic shell, unlock/PIN entry, root/flash/factory reset, unrelated private data, credentials/tokens, SMS/calls/payments | Not exposed or rejected |

Every action that can act on a phone is bound to the selected serial. Reconnection invalidates stale UI state and does not silently move the session to another device.

Semantic node IDs are valid only for the snapshot that produced them. A fresh post-action snapshot is the evidence that a tap or other action changed the device; a successful ADB exit code alone is not considered success.

Evidence is explicit and bounded. It is not a surveillance or continuous recording feature. Treat evidence directories as sensitive even after pattern-based redaction.
