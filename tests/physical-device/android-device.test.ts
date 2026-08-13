import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../src/config/loader.js';
import type { EvidenceSession } from '../../src/evidence/recorder.js';
import { AndroidDeviceService } from '../../src/service.js';
import { findMatches } from '../../src/ui/selectors.js';
import type { UiSelector } from '../../src/ui/types.js';

const enabled = process.env.ANDROID_DEVICE_MCP_PHYSICAL === '1';
const testPackage = process.env.ANDROID_DEVICE_MCP_TEST_PACKAGE;

test(
  'runs the opt-in harmless Android-device smoke workflow',
  { skip: !enabled || testPackage === undefined },
  async (t) => {
    const packageName = testPackage!;
    let selector: UiSelector;
    try {
      const rawSelector = process.env.ANDROID_DEVICE_MCP_TEST_SELECTOR;
      if (rawSelector === undefined) {
        t.skip(
          'Set ANDROID_DEVICE_MCP_TEST_SELECTOR to a known harmless element selector for the designated test app.',
        );
        return;
      }
      selector = JSON.parse(rawSelector) as UiSelector;
    } catch {
      t.skip('ANDROID_DEVICE_MCP_TEST_SELECTOR must be valid JSON.');
      return;
    }

    const config = loadConfig({
      env: {
        ...process.env,
        ANDROID_DEVICE_MCP_ALLOWED_PACKAGES: packageName,
      },
    });
    const service = new AndroidDeviceService(config);
    let evidence: EvidenceSession | null = null;
    try {
      const devices = await service.listDevices();
      const authorized = devices.filter((device) => device.authorized);
      if (authorized.length !== 1) {
        t.skip(`Expected exactly one authorized device; found ${authorized.length}.`);
        return;
      }
      const serial = authorized[0]!.serial;
      await service.selectDevice(serial);
      const info = await service.deviceInfo();
      assert.equal(info.serial, serial);

      await service.packages.launch(serial, packageName);
      const foreground = await service.waitForForeground(packageName);
      assert.equal(foreground.packageName, packageName);

      evidence = await service.beginEvidence('physical-smoke', { testPackage });
      const initialScreenshot = await service.screenshots.capture(serial);
      await evidence.saveScreenshot('initial', initialScreenshot.png);
      const initialUi = await service.captureUi();
      await evidence.saveUi('initial', initialUi);

      const launchedUi = await service.captureUi();
      const matches = findMatches(launchedUi, selector);
      assert.ok(
        matches.length > 0,
        'The configured harmless selector did not match the test application.',
      );
      const action = await service.tapSelector(selector, undefined, true, launchedUi);
      assert.equal(action.before.foreground.packageName, packageName);

      assert.equal(service.scrcpy.status().deviceSerial, serial);
      assert.equal(service.scrcpy.status().running, true);
      await service.scrcpy.stop();

      const logs = await service.captureLogcat(serial, {
        packageName,
        severity: 'W',
        durationMs: 250,
      });
      await evidence.saveLog('logcat', logs.text);
      const finished = await service.evidence.finish();
      assert.ok(finished.files.some((file) => file.path === 'summary.md'));
      evidence = null;
    } finally {
      if (evidence !== null && service.evidence.activeSession !== null)
        await service.evidence.finish();
      await service.close();
    }
  },
);
