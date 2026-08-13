# Phone setup

1. Back up anything important before enabling USB debugging.
2. On the phone, open **Settings → About phone** and tap **Build number** repeatedly until Developer Options are enabled.
3. Open **Developer Options** and enable **USB debugging**.
4. Connect the phone with a data-capable USB cable.
5. Unlock the phone and accept the Android RSA debugging prompt. Verify the displayed computer fingerprint before accepting.
6. On the workstation, run:

   ```zsh
   adb devices -l
   ```

7. Confirm the device state is `device`, not `unauthorized`, `offline`, or `no permissions`.

If the state is `unauthorized`, accept the prompt on the phone. If it is `offline`, reconnect the cable and let the user decide whether to restart ADB. If it is `no permissions`, fix the Linux udev/group configuration deliberately; this server does not modify udev rules or use elevated privileges.

The server will not unlock the phone, enter a PIN/password, dismiss user-consent prompts, or operate a locked device. Keep personal applications off the allowlist. Prefer a purpose-built harmless test app with a known package name and deterministic accessibility labels.

## Physical test prerequisites

Set an explicit allowlist before running opt-in physical tests:

```zsh
export ANDROID_DEVICE_MCP_ALLOWED_PACKAGES=com.example.androiddevicetest
export ANDROID_DEVICE_MCP_PHYSICAL=1
npm run test:physical
```

The current repository includes the physical-test harness location but does not invent a package or modify personal applications. The test gate is therefore expected to skip until a designated harmless test package is provided.
