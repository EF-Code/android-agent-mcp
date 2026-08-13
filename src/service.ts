import { randomUUID } from 'node:crypto';

import { AdbClient } from './adb/client.js';
import { DeviceManager } from './adb/devices.js';
import { AdbForeground } from './adb/foreground.js';
import { AdbInput, type AllowedKey } from './adb/input.js';
import { AdbInstaller } from './adb/installer.js';
import { AdbLogcat, type LogCaptureOptions } from './adb/logcat.js';
import { AdbPackages } from './adb/packages.js';
import { AdbPermissions } from './adb/permissions.js';
import { AdbProperties } from './adb/properties.js';
import { AdbScreenshots } from './adb/screenshots.js';
import { AdbUiAutomator } from './adb/ui-automator.js';
import { EvidenceManager, type EvidenceSession } from './evidence/recorder.js';
import { Policy } from './policy/policy.js';
import { AppError } from './errors/app-error.js';
import { ErrorCode } from './errors/codes.js';
import type { ServerConfig } from './config/types.js';
import type { DeviceInfo, ForegroundApp, ScreenObservation } from './types.js';
import { parseUiAutomatorXml } from './ui/parse.js';
import { SnapshotStore } from './ui/snapshots.js';
import { findMatches, resolveUniqueMatch } from './ui/selectors.js';
import type { UiSelector, UiSnapshot } from './ui/types.js';
import { validateCoordinate, validateDuration, validateLabel, validatePackageName } from './validation/common.js';
import { ScrcpyProcessManager } from './scrcpy/process-manager.js';

const STARTUP_WAIT_MS = 200;

export class AndroidDeviceService {
  readonly adb: AdbClient;
  readonly devices: DeviceManager;
  readonly policy: Policy;
  readonly foreground: AdbForeground;
  readonly input: AdbInput;
  readonly installer: AdbInstaller;
  readonly logcat: AdbLogcat;
  readonly packages: AdbPackages;
  readonly permissions: AdbPermissions;
  readonly properties: AdbProperties;
  readonly screenshots: AdbScreenshots;
  readonly uiAutomator: AdbUiAutomator;
  readonly snapshots: SnapshotStore;
  readonly scrcpy: ScrcpyProcessManager;
  readonly evidence: EvidenceManager;

  constructor(readonly config: ServerConfig) {
    this.adb = new AdbClient({ adbPath: config.adbPath, defaultTimeoutMs: config.defaultTimeoutMs, maxOutputBytes: config.maxCommandOutputBytes });
    this.policy = new Policy(config);
    this.devices = new DeviceManager(this.adb, config.autoSelectSingleDevice, () => this.snapshots.invalidate());
    this.foreground = new AdbForeground(this.adb);
    this.input = new AdbInput(this.adb);
    this.installer = new AdbInstaller(this.adb, config.allowedApkRoots, config.maxApkBytes);
    this.logcat = new AdbLogcat(this.adb, config.maxLogBytes);
    this.packages = new AdbPackages(this.adb);
    this.permissions = new AdbPermissions(this.adb, this.packages);
    this.properties = new AdbProperties(this.adb);
    this.screenshots = new AdbScreenshots(this.adb, config.maxScreenshotBytes);
    this.uiAutomator = new AdbUiAutomator(this.adb);
    this.snapshots = new SnapshotStore(config.uiSnapshotMaxAgeMs);
    this.scrcpy = new ScrcpyProcessManager(config.scrcpyPath, config.leaveScrcpyRunningOnExit);
    this.evidence = new EvidenceManager(config.evidenceRoot, config.maxEvidenceBytes, config.maxEvidenceFiles);
  }

  async close(): Promise<void> {
    await this.scrcpy.dispose();
  }

  async selectedSerial(): Promise<string> {
    return (await this.devices.requireSelected()).serial;
  }

  async screenObservation(serial = await this.selectedSerial()): Promise<ScreenObservation> {
    const display = await this.properties.display(serial);
    const foreground = await this.foreground.read(serial);
    return {
      display: { width: display.resolution?.width ?? 0, height: display.resolution?.height ?? 0, rotation: 0 },
      foreground,
      observedAt: new Date().toISOString(),
    };
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const serial = await this.selectedSerial();
    const [properties, display, battery, lockState, foreground] = await Promise.all([
      this.properties.read(serial),
      this.properties.display(serial),
      this.properties.battery(serial),
      this.properties.lockState(serial),
      this.foreground.read(serial),
    ]);
    return {
      serial,
      ...properties,
      resolution: display.resolution,
      density: display.density,
      battery,
      lockState,
      foreground,
      observedAt: new Date().toISOString(),
    };
  }

  async captureUi(): Promise<UiSnapshot> {
    const serial = await this.selectedSerial();
    const observation = await this.screenObservation(serial);
    const xml = await this.uiAutomator.dump(serial);
    return this.snapshots.put(
      parseUiAutomatorXml(xml, {
        snapshotId: randomUUID(),
        capturedAt: new Date().toISOString(),
        display: observation.display,
        foreground: observation.foreground,
      }),
    );
  }

  async currentForeground(): Promise<ForegroundApp> {
    return this.foreground.read(await this.selectedSerial());
  }

  async stabilize(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));
  }

  async verifyForeground(packageName: string): Promise<ForegroundApp> {
    const foreground = await this.currentForeground();
    if (foreground.packageName !== packageName) {
      throw new AppError(ErrorCode.CommandFailed, 'Application did not become the foreground package.', {
        retryable: true,
        details: { expectedPackage: packageName, foreground },
      });
    }
    return foreground;
  }

  async tapSelector(selector: UiSelector, matchIndex?: number): Promise<{ before: UiSnapshot; after: UiSnapshot; nodeId: string }> {
    const serial = await this.selectedSerial();
    const before = await this.captureUi();
    const match = resolveUniqueMatch(before, selector, matchIndex);
    if (!match.node.flags.enabled || match.node.bounds === null || match.node.center === null) {
      throw new AppError(ErrorCode.UiElementNotFound, 'The selected UI element is not visible and enabled with valid bounds.');
    }
    if (match.node.packageName !== null) this.policy.assertPackageAllowed(match.node.packageName);
    await this.input.tap(serial, match.node.center.x, match.node.center.y);
    await this.stabilize();
    const after = await this.captureUi();
    return { before, after, nodeId: match.node.nodeId };
  }

  async tapCoordinates(x: number, y: number, verifyChange: boolean): Promise<{ before: UiSnapshot | null; after: UiSnapshot | null }> {
    const serial = await this.selectedSerial();
    const observation = await this.screenObservation(serial);
    validateCoordinate(x, 'x');
    validateCoordinate(y, 'y');
    if (observation.display.width > 0 && (x >= observation.display.width || y >= observation.display.height)) {
      throw new AppError(ErrorCode.InvalidCoordinates, 'Coordinates are outside the native device display bounds.', {
        details: { x, y, display: observation.display },
      });
    }
    const before = verifyChange ? await this.captureUi() : null;
    await this.input.tap(serial, x, y);
    await this.stabilize();
    const after = verifyChange ? await this.captureUi() : null;
    return { before, after };
  }

  async swipe(options: { startX?: number; startY?: number; endX?: number; endY?: number; direction?: string; durationMs?: number; verifyChange: boolean }): Promise<{ before: UiSnapshot | null; after: UiSnapshot | null }> {
    const serial = await this.selectedSerial();
    const observation = await this.screenObservation(serial);
    const width = observation.display.width;
    const height = observation.display.height;
    let startX = options.startX;
    let startY = options.startY;
    let endX = options.endX;
    let endY = options.endY;
    if (options.direction !== undefined) {
      if (width <= 0 || height <= 0) throw new AppError(ErrorCode.InvalidInput, 'Cannot resolve a direction without display dimensions.');
      const marginX = Math.floor(width * 0.5);
      const marginY = Math.floor(height * 0.5);
      ({ startX, startY, endX, endY } = {
        up: { startX: marginX, startY: Math.floor(height * 0.75), endX: marginX, endY: Math.floor(height * 0.25) },
        down: { startX: marginX, startY: Math.floor(height * 0.25), endX: marginX, endY: Math.floor(height * 0.75) },
        left: { startX: Math.floor(width * 0.75), startY: marginY, endX: Math.floor(width * 0.25), endY: marginY },
        right: { startX: Math.floor(width * 0.25), startY: marginY, endX: Math.floor(width * 0.75), endY: marginY },
      }[options.direction as 'up' | 'down' | 'left' | 'right']);
    }
    if ([startX, startY, endX, endY].some((value) => value === undefined)) {
      throw new AppError(ErrorCode.InvalidInput, 'Swipe requires either direction or complete start/end coordinates.');
    }
    if (width > 0 && height > 0 && (startX! >= width || endX! >= width || startY! >= height || endY! >= height)) {
      throw new AppError(ErrorCode.InvalidCoordinates, 'Swipe coordinates are outside display bounds.');
    }
    const before = options.verifyChange ? await this.captureUi() : null;
    await this.input.swipe(serial, startX!, startY!, endX!, endY!, validateDuration(options.durationMs ?? 300, 'durationMs', 30_000));
    await this.stabilize();
    const after = options.verifyChange ? await this.captureUi() : null;
    return { before, after };
  }

  async waitForUi(options: { selector?: UiSelector; packageName?: string; activity?: string; disappearance?: boolean; screenChange?: boolean; timeoutMs: number; pollMs: number }): Promise<{ matched: boolean; elapsedMs: number; snapshot: UiSnapshot | null; foreground: ForegroundApp }> {
    const started = Date.now();
    let previousFingerprint: string | null = null;
    while (Date.now() - started <= options.timeoutMs) {
      const foreground = await this.currentForeground();
      const snapshot = options.selector === undefined && options.screenChange !== true ? null : await this.captureUi();
      const selectorMatches = options.selector === undefined || (snapshot !== null && findMatches(snapshot, options.selector).length > 0);
      const packageMatches = options.packageName === undefined || foreground.packageName === options.packageName;
      const activityMatches = options.activity === undefined || foreground.activity === options.activity;
      const fingerprint = snapshot === null ? null : JSON.stringify(snapshot.nodes.map((node) => [node.nodeId, node.text, node.bounds]));
      const changed = previousFingerprint !== null && fingerprint !== previousFingerprint;
      const screenMatches = options.screenChange !== true || changed;
      const present = selectorMatches && packageMatches && activityMatches && screenMatches;
      const matched = options.disappearance === true ? !present : present;
      if (matched) return { matched: true, elapsedMs: Date.now() - started, snapshot, foreground };
      previousFingerprint = fingerprint;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    }
    return { matched: false, elapsedMs: Date.now() - started, snapshot: this.snapshots.get() ?? null, foreground: await this.currentForeground() };
  }

  async beginEvidence(label: string | undefined, metadata: Record<string, unknown> | undefined): Promise<EvidenceSession> {
    const device = await this.deviceInfo();
    return this.evidence.begin({ serverVersion: '0.1.0', adbVersion: await this.adb.version(), scrcpyVersion: this.scrcpy.status().capabilities?.version ?? null, device, metadata }, label);
  }
}
