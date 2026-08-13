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

From the repository, `npm run check:environment -- --require-scrcpy` performs the read-only host tool check required by the default visible-mirror workflow.

If the state is `unauthorized`, accept the prompt on the phone. If it is `offline`, reconnect the cable and let the user decide whether to restart ADB. If it is `no permissions`, fix the Linux udev/group configuration deliberately; this server does not modify udev rules or use elevated privileges.

The server will not unlock the phone, enter a PIN/password, dismiss user-consent prompts, or operate a locked device. Normal MCP control permits valid non-sensitive packages by default; use `ANDROID_DEVICE_MCP_ALLOWED_PACKAGES` to narrow the session when desired. Selecting the device starts the visible scrcpy mirror unless auto-start is disabled.

## Physical test prerequisites

Set explicit inputs before running opt-in physical tests:

```zsh
export ANDROID_DEVICE_MCP_PHYSICAL=1
export ANDROID_DEVICE_MCP_TEST_PACKAGE=com.example.androiddevicetest
export ANDROID_DEVICE_MCP_TEST_SELECTOR='{"text":"Continue","clickable":true}'
npm run test:physical
```

The harness does not invent a package, selector, or phone and does not modify personal applications. It skips unless the explicit package and selector are supplied, exactly one authorized device is connected, and the harmless test app is prepared for this workflow. These variables affect only `npm run test:physical`; normal MCP control uses the configured package policy.
