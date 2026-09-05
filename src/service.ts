import { randomUUID } from 'node:crypto';

import { AdbClient } from './adb/client.js';
import { DeviceManager } from './adb/devices.js';
import { AdbForeground, parseForegroundActivity } from './adb/foreground.js';
import { AdbInput, type AllowedKey, type InputSequenceAction } from './adb/input.js';
import { AdbInstaller } from './adb/installer.js';
import { AdbLogcat, type LogCaptureOptions } from './adb/logcat.js';
import { AdbPackages } from './adb/packages.js';
import { AdbPermissions } from './adb/permissions.js';
import { AdbProperties } from './adb/properties.js';
import {
  AdbScreenshots,
  type EncodedScreenshot,
  type VisualFrameFormat,
} from './adb/screenshots.js';
import { AdbUiAutomator } from './adb/ui-automator.js';
import { EvidenceManager, type EvidenceSession } from './evidence/recorder.js';
import { Policy } from './policy/policy.js';
import { redactSensitiveUiText } from './policy/redaction.js';
import { AppError, asAppError } from './errors/app-error.js';
import { ErrorCode } from './errors/codes.js';
import type { ServerConfig } from './config/types.js';
import type { DeviceInfo, ForegroundApp, ScreenObservation } from './types.js';
import { parseUiAutomatorXml } from './ui/parse.js';
import { SnapshotStore } from './ui/snapshots.js';
import { findMatches, resolveUniqueMatch } from './ui/selectors.js';
import type { UiSelector, UiSnapshot } from './ui/types.js';
import { mapVisualInputActions, type VisualCoordinateSpace } from './visual-control.js';
import {
  validateCoordinate,
  validateDuration,
  validateLabel,
  validatePackageName,
} from './validation/common.js';
import type { ScrcpyStartOptions } from './scrcpy/capabilities.js';
import { ScrcpyDirectControl } from './scrcpy/direct-control.js';
import { ScrcpyProcessManager } from './scrcpy/process-manager.js';
import { OperationCoordinator } from './service/operation-coordinator.js';

const STARTUP_WAIT_MS = 200;

function sameForeground(left: ForegroundApp, right: ForegroundApp): boolean {
  return left.packageName === right.packageName && left.activity === right.activity;
}

export function uiStateFingerprint(snapshot: UiSnapshot): string {
  return JSON.stringify({
    display: snapshot.display,
    foreground: snapshot.foreground,
    nodes: snapshot.nodes.map((node) => ({
      className: node.className,
      packageName: node.packageName,
      text: node.text,
      contentDescription: node.contentDescription,
      resourceId: node.resourceId,
      flags: node.flags,
      bounds: node.bounds,
    })),
  });
}

function assertSameForeground(
  before: ForegroundApp,
  current: ForegroundApp,
  operation: string,
): void {
  if (sameForeground(before, current)) return;
  throw new AppError(
    ErrorCode.StaleUiSnapshot,
    `Foreground changed while preparing ${operation}.`,
    {
      retryable: true,
      details: { before, current },
    },
  );
}

export interface ActionObservation {
  before: UiSnapshot | null;
  after: UiSnapshot | null;
  beforePixelSha256: string | null;
  afterPixelSha256: string | null;
}

export interface VisualControlFrame {
  screenshot: EncodedScreenshot;
  foreground: ForegroundApp;
}

export interface VisualControlStartResult extends VisualControlFrame {
  sessionId: string;
  serial: string;
  coordinateSpace: VisualCoordinateSpace;
  startedAt: string;
}

export interface VisualControlActionResult extends VisualControlFrame {
  sessionId: string;
  serial: string;
  coordinateSpace: VisualCoordinateSpace;
  actionCount: number;
  changed: boolean;
  waitElapsedMs: number;
  elapsedMs: number;
  inputTransport: 'scrcpy' | 'adb';
  frameTransport: 'scrcpy' | 'adb';
  timingMs: {
    preflight: number;
    input: number;
    settle: number;
    observation: number;
    postflight: number;
  };
}

interface VisualControlSessionState {
  sessionId: string;
  serial: string;
  deviceSessionId: string;
  coordinateSpace: VisualCoordinateSpace;
  frameFormat: VisualFrameFormat;
  foregroundPackage: string;
  lastScreenshotSha256: string;
  screenWidth: number;
  screenHeight: number;
  startedAt: string;
}

export class AndroidDeviceService {
  readonly operations = new OperationCoordinator();
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
  readonly directControl: ScrcpyDirectControl;
  readonly evidence: EvidenceManager;
  private readonly activeLogControllers = new Set<AbortController>();
  private readonly displayGeometryCache = new Map<
    string,
    { sessionId: string; capturedAt: number; width: number; height: number }
  >();
  private readonly visualControlSessions = new Map<string, VisualControlSessionState>();
  private autoMirrorError: AppError | null = null;
  private autoMirrorAttemptedSessionId: string | null = null;

  constructor(readonly config: ServerConfig) {
    this.adb = new AdbClient({
      adbPath: config.adbPath,
      defaultTimeoutMs: config.defaultTimeoutMs,
      maxOutputBytes: config.maxCommandOutputBytes,
    });
    this.policy = new Policy(config);
    this.devices = new DeviceManager(this.adb, config.autoSelectSingleDevice, (serial) =>
      this.handleDisconnect(serial),
    );
    this.foreground = new AdbForeground(this.adb);
    this.input = new AdbInput(this.adb);
    this.installer = new AdbInstaller(this.adb, config.allowedApkRoots, config.maxApkBytes);
    this.logcat = new AdbLogcat(this.adb, config.maxLogBytes);
    this.packages = new AdbPackages(this.adb);
    this.permissions = new AdbPermissions(
      this.adb,
      this.packages,
      config.allowedRuntimePermissions,
    );
    this.properties = new AdbProperties(this.adb);
    this.screenshots = new AdbScreenshots(this.adb, config.maxScreenshotBytes);
    this.uiAutomator = new AdbUiAutomator(this.adb);
    this.snapshots = new SnapshotStore(config.uiSnapshotMaxAgeMs);
    this.scrcpy = new ScrcpyProcessManager(config.scrcpyPath, config.mirror.leaveRunningOnExit);
    this.directControl = new ScrcpyDirectControl(this.adb);
    this.evidence = new EvidenceManager(
      config.evidenceRoot,
      config.maxEvidenceBytes,
      config.maxEvidenceFiles,
      config.evidenceRetentionMaxAgeMs,
    );
  }

  async close(): Promise<void> {
    for (const controller of this.activeLogControllers) controller.abort();
    this.visualControlSessions.clear();
    try {
      await Promise.all([this.scrcpy.dispose(), this.directControl.close()]);
    } finally {
      if (this.evidence.activeSession !== null) await this.evidence.finish();
    }
  }

  private handleDisconnect(serial: string): void {
    this.snapshots.invalidate();
    this.displayGeometryCache.delete(serial);
    for (const [sessionId, session] of this.visualControlSessions) {
      if (session.serial === serial) this.visualControlSessions.delete(sessionId);
    }
    this.scrcpy.markDetached(serial);
    void this.directControl.close();
    this.autoMirrorAttemptedSessionId = null;
    for (const controller of this.activeLogControllers) controller.abort();
    this.evidence.pause(`selected device ${serial} disconnected`);
  }

  async selectedSerial(options: { checkConnection?: boolean } = {}): Promise<string> {
    const selected = await this.devices.requireSelected(options);
    await this.ensureAutoMirror();
    return selected.serial;
  }

  async listDevices(): Promise<Awaited<ReturnType<DeviceManager['list']>>> {
    const devices = await this.devices.list();
    await this.ensureAutoMirror();
    return devices;
  }

  async selectDevice(serial: string): Promise<Awaited<ReturnType<DeviceManager['select']>>> {
    await this.directControl.close();
    const result = await this.devices.select(serial);
    this.displayGeometryCache.delete(serial);
    this.visualControlSessions.clear();
    await this.ensureAutoMirror();
    return result;
  }

  private async ensureAutoMirror(): Promise<void> {
    if (!this.config.mirror.autoStart || this.devices.selected === null) return;
    const selected = this.devices.selected;
    const serial = selected.serial;
    const status = this.scrcpy.status();
    if (status.running && status.deviceSerial === serial && !status.detached) {
      this.autoMirrorAttemptedSessionId = selected.sessionId;
      return;
    }
    if (this.autoMirrorAttemptedSessionId === selected.sessionId) return;
    this.autoMirrorAttemptedSessionId = selected.sessionId;
    try {
      await this.scrcpy.start(serial, {
        maxSize: this.config.mirror.maxSize,
        maxFps: this.config.mirror.maxFps,
        audio: this.config.mirror.audio,
        control: true,
        stayAwake: false,
        turnScreenOff: false,
        windowTitle: 'Android Agent MCP',
      });
      this.autoMirrorError = null;
    } catch (error) {
      // Mirroring is an observation aid. Ordinary ADB tools must continue to
      // work when scrcpy is missing, unsupported, or cannot open a display.
      this.autoMirrorError = asAppError(error);
    }
  }

  get autoMirrorWarning(): { code: string; message: string; retryable: boolean } | null {
    if (this.autoMirrorError === null) return null;
    return {
      code: this.autoMirrorError.code,
      message: `Visible scrcpy auto-start failed: ${this.autoMirrorError.message}`,
      retryable: this.autoMirrorError.retryable,
    };
  }

  async startMirror(
    serial: string,
    options: ScrcpyStartOptions,
  ): Promise<Awaited<ReturnType<ScrcpyProcessManager['start']>>> {
    const result = await this.scrcpy.start(serial, options);
    this.autoMirrorError = null;
    return result;
  }

  async screenObservation(serial?: string): Promise<ScreenObservation> {
    const selectedSerial = serial ?? (await this.selectedSerial());
    const [display, rotation] = await Promise.all([
      this.properties.display(selectedSerial),
      this.properties.rotation(selectedSerial),
    ]);
    const foreground = await this.foreground.read(selectedSerial);
    return {
      display: {
        width: display.resolution?.width ?? 0,
        height: display.resolution?.height ?? 0,
        rotation,
      },
      foreground,
      observedAt: new Date().toISOString(),
    };
  }

  private async screenGeometry(serial: string): Promise<{ width: number; height: number }> {
    const session = this.devices.selected;
    const cached = this.displayGeometryCache.get(serial);
    if (
      cached !== undefined &&
      (session === null || cached.sessionId === session.sessionId) &&
      Date.now() - cached.capturedAt <= this.config.displayGeometryMaxAgeMs
    ) {
      return { width: cached.width, height: cached.height };
    }
    const resolution = await this.properties.resolution(serial);
    const geometry = { width: resolution?.width ?? 0, height: resolution?.height ?? 0 };
    if (session !== null && session.serial === serial) {
      this.displayGeometryCache.set(serial, {
        sessionId: session.sessionId,
        capturedAt: Date.now(),
        ...geometry,
      });
    }
    return geometry;
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
    const session = await this.devices.requireSelected();
    const serial = session.serial;
    const observation = await this.screenObservation(serial);
    const xml = await this.uiAutomator.dump(serial);
    const finalObservation = await this.screenObservation(serial);
    const foregroundChanged = !sameForeground(observation.foreground, finalObservation.foreground);
    const snapshot = parseUiAutomatorXml(xml, {
      snapshotId: randomUUID(),
      deviceSerial: session.serial,
      deviceSessionId: session.sessionId,
      capturedAt: new Date().toISOString(),
      display: finalObservation.display,
      foreground: finalObservation.foreground,
    });
    if (foregroundChanged) {
      snapshot.warnings.push({
        code: 'FOREGROUND_CHANGED_DURING_CAPTURE',
        message: 'The foreground application changed while the UI hierarchy was being captured.',
        details: {
          before: observation.foreground,
          after: finalObservation.foreground,
        },
      });
    }
    const shouldRedact =
      !this.policy.canRecordPackage(observation.foreground.packageName) ||
      !this.policy.canRecordPackage(finalObservation.foreground.packageName);
    if (shouldRedact)
      this.evidence.pause('foreground package is sensitive, unavailable, or outside the allowlist');
    const safeSnapshot: UiSnapshot = shouldRedact
      ? {
          ...snapshot,
          nodes: snapshot.nodes.map((node) => ({
            ...node,
            text: redactSensitiveUiText(node.text),
            contentDescription: redactSensitiveUiText(node.contentDescription),
          })),
          warnings: [
            ...snapshot.warnings,
            {
              code: 'SENSITIVE_FOREGROUND_REDACTED',
              message:
                'UI text and content descriptions were redacted because foreground package authorization was unavailable or restrictive.',
            },
          ],
        }
      : snapshot;
    return this.snapshots.put(safeSnapshot);
  }

  async currentForeground(serial?: string): Promise<ForegroundApp> {
    return this.foreground.read(serial ?? (await this.selectedSerial()));
  }

  async requireAllowedForeground(operation: string, serial?: string): Promise<ForegroundApp> {
    const foreground = await this.currentForeground(serial);
    this.policy.assertForegroundAllowed(foreground, operation);
    return foreground;
  }

  async requireCaptureForeground(operation: string, serial?: string): Promise<ForegroundApp> {
    const foreground = await this.currentForeground(serial);
    this.assertCaptureForeground(foreground, operation);
    return foreground;
  }

  private assertCaptureForeground(foreground: ForegroundApp, operation: string): void {
    if (
      foreground.packageName === null ||
      !this.policy.isPackageAllowed(foreground.packageName) ||
      this.policy.isSensitivePackage(foreground.packageName)
    ) {
      this.evidence.pause(
        `capture blocked for ${foreground.packageName ?? 'unknown'} foreground package`,
      );
    }
    this.policy.assertObservationAllowed(foreground, operation);
  }

  private async requireCapturedForeground(
    output: string,
    operation: string,
    serial: string,
  ): Promise<ForegroundApp> {
    const foreground = parseForegroundActivity(output);
    if (foreground.packageName === null) {
      return this.requireCaptureForeground(operation, serial);
    }
    this.assertCaptureForeground(foreground, operation);
    return foreground;
  }

  async captureActionScreenshot(
    serial: string,
  ): Promise<Awaited<ReturnType<AdbScreenshots['capture']>>> {
    await this.requireCaptureForeground('action screenshot', serial);
    return this.screenshots.capture(serial);
  }

  async captureScreen(serial: string): Promise<{
    screenshot: Awaited<ReturnType<AdbScreenshots['capture']>>;
    rotation: 0 | 1 | 2 | 3;
    foreground: ForegroundApp;
  }> {
    await this.requireCaptureForeground('screen capture', serial);
    const [screenshot, rotation] = await Promise.all([
      this.screenshots.capture(serial),
      this.properties.rotation(serial),
    ]);
    const foreground = await this.requireCaptureForeground('screen capture result', serial);
    return { screenshot, rotation, foreground };
  }

  private async captureVisualFrame(
    serial: string,
    operation: string,
    frameFormat: VisualFrameFormat,
  ): Promise<VisualControlFrame> {
    await this.requireCaptureForeground(`${operation} before capture`, serial);
    const observation = await this.screenshots.captureVisualObservation(serial, frameFormat);
    const foreground = await this.requireCapturedForeground(
      observation.foregroundOutput,
      `${operation} after capture`,
      serial,
    );
    return { screenshot: observation.screenshot, foreground };
  }

  private async requireVisualControlSession(
    sessionId: string,
  ): Promise<{ state: VisualControlSessionState; serial: string }> {
    const state = this.visualControlSessions.get(sessionId);
    if (state === undefined) {
      throw new AppError(
        ErrorCode.SessionConflict,
        'Visual control session is unknown or expired; start a new session.',
        { retryable: true, details: { sessionId } },
      );
    }
    const selected = await this.devices.requireSelected({ checkConnection: false });
    if (selected.sessionId !== state.deviceSessionId || selected.serial !== state.serial) {
      this.visualControlSessions.delete(sessionId);
      throw new AppError(
        ErrorCode.SessionConflict,
        'Visual control session is bound to a different device session; start a new session.',
        {
          retryable: true,
          details: {
            sessionId,
            sessionSerial: state.serial,
            selectedSerial: selected.serial,
          },
        },
      );
    }
    return { state, serial: state.serial };
  }

  private async waitForVisualChange(
    serial: string,
    baselineSha256: string,
    frameFormat: VisualFrameFormat,
    waitForChangeMs: number,
    stableMs: number,
    pollMs: number,
    initialObservation?: VisualControlFrame,
  ): Promise<{
    screenshot: EncodedScreenshot;
    foreground: ForegroundApp;
    changed: boolean;
    elapsedMs: number;
  }> {
    const started = performance.now();
    let observation =
      initialObservation === undefined
        ? await this.screenshots.captureVisualObservation(serial, frameFormat)
        : null;
    let screenshot = initialObservation?.screenshot ?? observation!.screenshot;
    let foreground =
      initialObservation?.foreground ??
      (await this.requireCapturedForeground(
        observation!.foregroundOutput,
        'visual control observation',
        serial,
      ));
    let changed = screenshot.sha256 !== baselineSha256;
    if (waitForChangeMs === 0 || (!changed && performance.now() - started >= waitForChangeMs)) {
      return {
        screenshot,
        foreground,
        changed,
        elapsedMs: Math.round(performance.now() - started),
      };
    }

    while (!changed && performance.now() - started < waitForChangeMs) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      observation = await this.screenshots.captureVisualObservation(serial, frameFormat);
      screenshot = observation.screenshot;
      foreground = await this.requireCapturedForeground(
        observation.foregroundOutput,
        'visual control observation',
        serial,
      );
      changed = screenshot.sha256 !== baselineSha256;
    }
    if (!changed || stableMs === 0) {
      return {
        screenshot,
        foreground,
        changed,
        elapsedMs: Math.round(performance.now() - started),
      };
    }

    let stableSince = performance.now();
    while (performance.now() - started < waitForChangeMs) {
      if (performance.now() - stableSince >= stableMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      observation = await this.screenshots.captureVisualObservation(serial, frameFormat);
      const next = observation.screenshot;
      foreground = await this.requireCapturedForeground(
        observation.foregroundOutput,
        'visual control observation',
        serial,
      );
      if (next.sha256 !== screenshot.sha256) {
        screenshot = next;
        stableSince = performance.now();
      }
    }
    return {
      screenshot,
      foreground,
      changed,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  async visualControlStart(
    coordinateSpace: VisualCoordinateSpace = 'normalized_1000',
    frameFormat: VisualFrameFormat = 'jpeg',
  ): Promise<VisualControlStartResult> {
    const serial = await this.selectedSerial();
    const selected = await this.devices.requireSelected({ checkConnection: false });
    const existing = [...this.visualControlSessions.values()].find(
      (session) => session.serial === serial,
    );
    if (existing !== undefined) {
      throw new AppError(
        ErrorCode.SessionConflict,
        'A visual control session is already active for the selected device.',
        {
          retryable: true,
          details: { sessionId: existing.sessionId, serial },
        },
      );
    }
    const [frame] = await Promise.all([
      this.captureVisualFrame(serial, 'visual control start', frameFormat),
      this.directControl.ensureStarted(serial),
    ]);
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    this.visualControlSessions.set(sessionId, {
      sessionId,
      serial,
      deviceSessionId: selected.sessionId,
      coordinateSpace,
      frameFormat,
      foregroundPackage: frame.foreground.packageName!,
      lastScreenshotSha256: frame.screenshot.sha256,
      screenWidth: frame.screenshot.width,
      screenHeight: frame.screenshot.height,
      startedAt,
    });
    return { sessionId, serial, coordinateSpace, startedAt, ...frame };
  }

  async visualControlAction(options: {
    sessionId: string;
    actions: readonly InputSequenceAction[];
    coordinateSpace?: VisualCoordinateSpace;
    interActionDelayMs?: number;
    settleMs?: number;
    waitForChangeMs?: number;
    stableMs?: number;
    pollMs?: number;
  }): Promise<VisualControlActionResult> {
    const started = performance.now();
    const { state, serial } = await this.requireVisualControlSession(options.sessionId);
    const coordinateSpace = options.coordinateSpace ?? state.coordinateSpace;
    let preflightMs = 0;
    const geometry = { width: state.screenWidth, height: state.screenHeight };
    const actions = mapVisualInputActions(
      options.actions,
      coordinateSpace,
      geometry.width,
      geometry.height,
    );
    const assertInBounds = (x: number, y: number): void => {
      if (geometry.width > 0 && (x >= geometry.width || y >= geometry.height)) {
        throw new AppError(
          ErrorCode.InvalidCoordinates,
          'Visual control coordinates are outside the native device display bounds.',
          { details: { x, y, display: geometry, coordinateSpace } },
        );
      }
    };
    for (const action of actions) {
      if (action.type === 'tap') assertInBounds(action.x, action.y);
      if (action.type === 'swipe') {
        assertInBounds(action.startX, action.startY);
        assertInBounds(action.endX, action.endY);
      }
    }
    const settleMs = options.settleMs ?? 0;
    const waitForChangeMs = options.waitForChangeMs ?? 0;
    const stableMs = options.stableMs ?? 0;
    const pollMs = options.pollMs ?? 100;
    validateDuration(settleMs, 'settleMs', 2_000);
    validateDuration(waitForChangeMs, 'waitForChangeMs', 15_000);
    validateDuration(stableMs, 'stableMs', 2_000);
    validateDuration(pollMs, 'pollMs', 1_000);
    if (pollMs < 50) {
      throw new AppError(ErrorCode.InvalidInput, 'pollMs must be at least 50 milliseconds.', {
        details: { pollMs },
      });
    }
    const streamBaseline =
      state.frameFormat === 'jpeg'
        ? (this.scrcpy.latestFrame() ?? (await this.scrcpy.waitForFrame(0, 300)))
        : null;
    const actionStarted = performance.now();
    let frame: VisualControlFrame;
    let inputMs: number;
    let settleElapsedMs: number;
    let inputTransport: 'scrcpy' | 'adb' = 'adb';
    let frameTransport: 'scrcpy' | 'adb' = 'adb';
    if (streamBaseline !== null) {
      const preflightStarted = performance.now();
      const currentForeground = await this.requireAllowedForeground(
        'visual control direct input',
        serial,
      );
      assertSameForeground(
        { packageName: state.foregroundPackage, activity: currentForeground.activity, pid: null },
        currentForeground,
        'visual control direct input',
      );
      const directReady = await this.directControl.ensureStarted(serial);
      preflightMs = Math.round(performance.now() - preflightStarted);
      const inputStarted = performance.now();
      if (directReady) {
        inputTransport = 'scrcpy';
        await this.directControl.sequence(
          actions,
          geometry.width,
          geometry.height,
          options.interActionDelayMs ?? 0,
        );
      } else {
        await this.input.guardedSequence(
          serial,
          actions,
          state.foregroundPackage,
          options.interActionDelayMs ?? 0,
        );
      }
      inputMs = Math.round(performance.now() - inputStarted);
      const settleStarted = performance.now();
      await this.stabilize(settleMs);
      settleElapsedMs = Math.round(performance.now() - settleStarted);
      const streamed = await this.scrcpy.waitForFrame(streamBaseline.sequence, 1_000);
      if (streamed === null) {
        frame = await this.captureVisualFrame(
          serial,
          'visual control stream fallback',
          state.frameFormat,
        );
      } else {
        frameTransport = 'scrcpy';
        frame = {
          screenshot: streamed,
          foreground: await this.requireCaptureForeground(
            'visual control streamed observation',
            serial,
          ),
        };
      }
    } else {
      const observation = await this.screenshots.captureVisualAction(
        serial,
        actions,
        state.foregroundPackage,
        options.interActionDelayMs ?? 0,
        settleMs,
        state.frameFormat,
      );
      inputMs = Math.round(performance.now() - actionStarted);
      settleElapsedMs = settleMs;
      frame = {
        screenshot: observation.screenshot,
        foreground: await this.requireCapturedForeground(
          observation.foregroundOutput,
          'visual control observation',
          serial,
        ),
      };
    }
    const waited = await this.waitForVisualChange(
      serial,
      state.lastScreenshotSha256,
      state.frameFormat,
      waitForChangeMs,
      stableMs,
      pollMs,
      frame,
    );
    state.lastScreenshotSha256 = waited.screenshot.sha256;
    state.foregroundPackage = waited.foreground.packageName!;
    return {
      sessionId: options.sessionId,
      serial,
      coordinateSpace,
      actionCount: actions.length,
      changed: waited.changed,
      waitElapsedMs: waited.elapsedMs,
      elapsedMs: Math.round(performance.now() - started),
      inputTransport,
      frameTransport,
      timingMs: {
        preflight: preflightMs,
        input: inputMs,
        settle: settleElapsedMs,
        observation: waited.elapsedMs,
        postflight: 0,
      },
      screenshot: waited.screenshot,
      foreground: waited.foreground,
    };
  }

  visualControlStop(sessionId: string): { sessionId: string; stopped: true } {
    if (!this.visualControlSessions.delete(sessionId)) {
      throw new AppError(
        ErrorCode.SessionConflict,
        'Visual control session is unknown or already stopped.',
        { retryable: true, details: { sessionId } },
      );
    }
    return { sessionId, stopped: true };
  }

  async requireFreshSnapshot(snapshotId: string): Promise<UiSnapshot> {
    const session = await this.devices.requireSelected();
    return this.snapshots.requireFresh(snapshotId, {
      foreground: await this.currentForeground(),
      deviceSerial: session.serial,
      deviceSessionId: session.sessionId,
    });
  }

  private async pixelDigest(serial?: string): Promise<string> {
    await this.requireCaptureForeground('pixel verification', serial);
    return (await this.screenshots.capture(serial ?? (await this.selectedSerial()))).sha256;
  }

  async captureLogcat(
    serial: string,
    options: Omit<LogCaptureOptions, 'signal'> = {},
  ): Promise<Awaited<ReturnType<AdbLogcat['capture']>>> {
    const controller = new AbortController();
    this.activeLogControllers.add(controller);
    try {
      return await this.logcat.capture(serial, { ...options, signal: controller.signal });
    } finally {
      this.activeLogControllers.delete(controller);
    }
  }

  async stabilize(milliseconds = STARTUP_WAIT_MS): Promise<void> {
    validateDuration(milliseconds, 'settleMs', 2_000);
    if (milliseconds === 0) return;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async verifyForeground(packageName: string): Promise<ForegroundApp> {
    const foreground = await this.currentForeground();
    if (foreground.packageName !== packageName) {
      throw new AppError(
        ErrorCode.CommandFailed,
        'Application did not become the foreground package.',
        {
          retryable: true,
          details: { expectedPackage: packageName, foreground },
        },
      );
    }
    return foreground;
  }

  async waitForForeground(
    packageName: string,
    timeoutMs = 5_000,
    pollMs = 200,
  ): Promise<ForegroundApp> {
    validatePackageName(packageName);
    const started = Date.now();
    let foreground = await this.currentForeground();
    while (Date.now() - started <= timeoutMs) {
      if (foreground.packageName === packageName) return foreground;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      foreground = await this.currentForeground();
    }
    throw new AppError(
      ErrorCode.CommandFailed,
      'Application did not become the foreground package within the verification window.',
      {
        retryable: true,
        details: { expectedPackage: packageName, foreground, timeoutMs },
      },
    );
  }

  async tapSelector(
    selector: UiSelector,
    matchIndex?: number,
    verifyChange = true,
    sourceSnapshot?: UiSnapshot,
    verifyPixels = false,
  ): Promise<{
    before: UiSnapshot;
    after: UiSnapshot | null;
    nodeId: string;
    beforePixelSha256: string | null;
    afterPixelSha256: string | null;
  }> {
    const serial = await this.selectedSerial();
    const foreground = await this.requireAllowedForeground('semantic tap', serial);
    const before =
      sourceSnapshot === undefined
        ? await this.captureUi()
        : await this.requireFreshSnapshot(sourceSnapshot.snapshotId);
    const beforePixelSha256 = verifyPixels ? await this.pixelDigest() : null;
    this.policy.assertForegroundAllowed(before.foreground, 'semantic tap');
    assertSameForeground(foreground, before.foreground, 'the semantic tap');
    const match = resolveUniqueMatch(before, selector, matchIndex);
    if (!match.node.flags.enabled || match.node.bounds === null || match.node.center === null) {
      throw new AppError(
        ErrorCode.UiElementNotFound,
        'The selected UI element is not visible and enabled with valid bounds.',
      );
    }
    if (match.node.packageName === null || match.node.packageName !== foreground.packageName) {
      throw new AppError(
        ErrorCode.PackageNotAllowed,
        'The semantic target package is missing or differs from the authorized foreground package.',
        {
          details: {
            targetPackage: match.node.packageName,
            foregroundPackage: foreground.packageName,
          },
        },
      );
    }
    this.policy.assertPackageAllowed(match.node.packageName);
    const actionForeground = await this.requireAllowedForeground(
      'semantic tap before action',
      serial,
    );
    assertSameForeground(before.foreground, actionForeground, 'the semantic tap');
    await this.input.tap(serial, match.node.center.x, match.node.center.y);
    await this.stabilize(verifyChange ? STARTUP_WAIT_MS : 0);
    const after = verifyChange ? await this.captureUi() : null;
    const afterPixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    return { before, after, nodeId: match.node.nodeId, beforePixelSha256, afterPixelSha256 };
  }

  async tapCoordinates(
    x: number,
    y: number,
    verifyChange: boolean,
    verifyPixels = false,
    settleMs?: number,
  ): Promise<ActionObservation> {
    const serial = await this.selectedSerial({ checkConnection: false });
    const [, geometry] = await Promise.all([
      this.requireAllowedForeground('screen tap', serial),
      this.screenGeometry(serial),
    ]);
    validateCoordinate(x, 'x');
    validateCoordinate(y, 'y');
    if (geometry.width > 0 && (x >= geometry.width || y >= geometry.height)) {
      throw new AppError(
        ErrorCode.InvalidCoordinates,
        'Coordinates are outside the native device display bounds.',
        {
          details: { x, y, display: geometry },
        },
      );
    }
    const before = verifyChange ? await this.captureUi() : null;
    const beforePixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    if (verifyChange || verifyPixels)
      await this.requireAllowedForeground('screen tap before action', serial);
    await this.input.tap(serial, x, y);
    await this.stabilize(settleMs ?? (verifyChange ? STARTUP_WAIT_MS : 0));
    const after = verifyChange ? await this.captureUi() : null;
    const afterPixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    return { before, after, beforePixelSha256, afterPixelSha256 };
  }

  async swipe(options: {
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    direction?: string;
    durationMs?: number;
    verifyChange: boolean;
    verifyPixels?: boolean;
    settleMs?: number;
  }): Promise<ActionObservation> {
    const serial = await this.selectedSerial({ checkConnection: false });
    const [, geometry] = await Promise.all([
      this.requireAllowedForeground('screen swipe', serial),
      this.screenGeometry(serial),
    ]);
    const width = geometry.width;
    const height = geometry.height;
    let startX = options.startX;
    let startY = options.startY;
    let endX = options.endX;
    let endY = options.endY;
    if (options.direction !== undefined) {
      if (width <= 0 || height <= 0)
        throw new AppError(
          ErrorCode.InvalidInput,
          'Cannot resolve a direction without display dimensions.',
        );
      const marginX = Math.floor(width * 0.5);
      const marginY = Math.floor(height * 0.5);
      ({ startX, startY, endX, endY } = {
        up: {
          startX: marginX,
          startY: Math.floor(height * 0.75),
          endX: marginX,
          endY: Math.floor(height * 0.25),
        },
        down: {
          startX: marginX,
          startY: Math.floor(height * 0.25),
          endX: marginX,
          endY: Math.floor(height * 0.75),
        },
        left: {
          startX: Math.floor(width * 0.75),
          startY: marginY,
          endX: Math.floor(width * 0.25),
          endY: marginY,
        },
        right: {
          startX: Math.floor(width * 0.25),
          startY: marginY,
          endX: Math.floor(width * 0.75),
          endY: marginY,
        },
      }[options.direction as 'up' | 'down' | 'left' | 'right']);
    }
    if ([startX, startY, endX, endY].some((value) => value === undefined)) {
      throw new AppError(
        ErrorCode.InvalidInput,
        'Swipe requires either direction or complete start/end coordinates.',
      );
    }
    if (
      width > 0 &&
      height > 0 &&
      (startX! >= width || endX! >= width || startY! >= height || endY! >= height)
    ) {
      throw new AppError(
        ErrorCode.InvalidCoordinates,
        'Swipe coordinates are outside display bounds.',
      );
    }
    const before = options.verifyChange ? await this.captureUi() : null;
    const beforePixelSha256 = options.verifyPixels === true ? await this.pixelDigest(serial) : null;
    if (options.verifyChange || options.verifyPixels === true)
      await this.requireAllowedForeground('screen swipe before action', serial);
    await this.input.swipe(
      serial,
      startX!,
      startY!,
      endX!,
      endY!,
      validateDuration(options.durationMs ?? 300, 'durationMs', 30_000),
    );
    await this.stabilize(options.settleMs ?? (options.verifyChange ? STARTUP_WAIT_MS : 0));
    const after = options.verifyChange ? await this.captureUi() : null;
    const afterPixelSha256 = options.verifyPixels === true ? await this.pixelDigest(serial) : null;
    return { before, after, beforePixelSha256, afterPixelSha256 };
  }

  async inputSequence(options: {
    actions: readonly InputSequenceAction[];
    interActionDelayMs?: number;
    verifyChange: boolean;
    verifyPixels?: boolean;
    settleMs?: number;
  }): Promise<ActionObservation> {
    const serial = await this.selectedSerial({ checkConnection: false });
    const [, geometry] = await Promise.all([
      this.requireAllowedForeground('screen input sequence', serial),
      this.screenGeometry(serial),
    ]);
    const assertInBounds = (x: number, y: number): void => {
      validateCoordinate(x, 'coordinate');
      validateCoordinate(y, 'coordinate');
      if (geometry.width > 0 && (x >= geometry.width || y >= geometry.height)) {
        throw new AppError(
          ErrorCode.InvalidCoordinates,
          'Input sequence coordinates are outside display bounds.',
          { details: { x, y, display: geometry } },
        );
      }
    };
    for (const action of options.actions) {
      if (action.type === 'tap' || action.type === 'key') {
        if (action.type === 'tap') assertInBounds(action.x, action.y);
      } else {
        assertInBounds(action.startX, action.startY);
        assertInBounds(action.endX, action.endY);
        validateDuration(action.durationMs, 'durationMs', 30_000);
      }
    }
    validateDuration(options.interActionDelayMs ?? 0, 'interActionDelayMs', 1_000);
    const before = options.verifyChange ? await this.captureUi() : null;
    const beforePixelSha256 = options.verifyPixels === true ? await this.pixelDigest(serial) : null;
    if (options.verifyChange || options.verifyPixels === true)
      await this.requireAllowedForeground('screen input sequence before action', serial);
    await this.input.sequence(serial, options.actions, options.interActionDelayMs ?? 0);
    await this.stabilize(options.settleMs ?? (options.verifyChange ? STARTUP_WAIT_MS : 0));
    const after = options.verifyChange ? await this.captureUi() : null;
    const afterPixelSha256 = options.verifyPixels === true ? await this.pixelDigest(serial) : null;
    return { before, after, beforePixelSha256, afterPixelSha256 };
  }

  async longPress(
    x: number,
    y: number,
    durationMs: number,
    verifyChange = true,
    verifyPixels = false,
    settleMs?: number,
  ): Promise<ActionObservation> {
    const serial = await this.selectedSerial({ checkConnection: false });
    const [, geometry] = await Promise.all([
      this.requireAllowedForeground('screen long press', serial),
      this.screenGeometry(serial),
    ]);
    if (geometry.width > 0 && (x >= geometry.width || y >= geometry.height)) {
      throw new AppError(
        ErrorCode.InvalidCoordinates,
        'Long-press coordinates are outside the native device display bounds.',
        {
          details: { x, y, display: geometry },
        },
      );
    }
    const before = verifyChange ? await this.captureUi() : null;
    const beforePixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    if (verifyChange || verifyPixels)
      await this.requireAllowedForeground('screen long press before action', serial);
    await this.input.longPress(serial, x, y, validateDuration(durationMs, 'durationMs', 30_000));
    await this.stabilize(settleMs ?? (verifyChange ? STARTUP_WAIT_MS : 0));
    const after = verifyChange ? await this.captureUi() : null;
    const afterPixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    return { before, after, beforePixelSha256, afterPixelSha256 };
  }

  async pressKey(
    key: AllowedKey,
    verifyChange = true,
    verifyPixels = false,
    settleMs?: number,
  ): Promise<ActionObservation> {
    const serial = await this.selectedSerial({ checkConnection: false });
    await this.requireAllowedForeground('key press', serial);
    const before = verifyChange ? await this.captureUi() : null;
    const beforePixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    if (verifyChange || verifyPixels)
      await this.requireAllowedForeground('key press before action', serial);
    await this.input.key(serial, key);
    await this.stabilize(settleMs ?? (verifyChange ? STARTUP_WAIT_MS : 0));
    const after = verifyChange ? await this.captureUi() : null;
    const afterPixelSha256 = verifyPixels ? await this.pixelDigest(serial) : null;
    return { before, after, beforePixelSha256, afterPixelSha256 };
  }

  async waitForUi(options: {
    selector?: UiSelector;
    packageName?: string;
    activity?: string;
    disappearance?: boolean;
    screenChange?: boolean;
    timeoutMs: number;
    pollMs: number;
  }): Promise<{
    matched: boolean;
    elapsedMs: number;
    snapshot: UiSnapshot | null;
    foreground: ForegroundApp;
  }> {
    const started = Date.now();
    let previousFingerprint: string | null = null;
    while (Date.now() - started <= options.timeoutMs) {
      const foreground = await this.currentForeground();
      const snapshot =
        options.selector === undefined && options.screenChange !== true
          ? null
          : await this.captureUi();
      const selectorMatches =
        options.selector === undefined ||
        (snapshot !== null && findMatches(snapshot, options.selector).length > 0);
      const packageMatches =
        options.packageName === undefined || foreground.packageName === options.packageName;
      const activityMatches =
        options.activity === undefined || foreground.activity === options.activity;
      const fingerprint = snapshot === null ? null : uiStateFingerprint(snapshot);
      const changed = previousFingerprint !== null && fingerprint !== previousFingerprint;
      const screenMatches = options.screenChange !== true || changed;
      const present = selectorMatches && packageMatches && activityMatches && screenMatches;
      const matched = options.disappearance === true ? !present : present;
      if (matched) return { matched: true, elapsedMs: Date.now() - started, snapshot, foreground };
      previousFingerprint = fingerprint;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    }
    return {
      matched: false,
      elapsedMs: Date.now() - started,
      snapshot: this.snapshots.get() ?? null,
      foreground: await this.currentForeground(),
    };
  }

  async beginEvidence(
    label: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Promise<EvidenceSession> {
    const device = await this.deviceInfo();
    const manifest = {
      serverVersion: '0.5.0',
      adbVersion: await this.adb.version(),
      scrcpyVersion: this.scrcpy.status().capabilities?.version ?? null,
      device,
      ...(metadata === undefined ? {} : { metadata }),
    };
    const session = await this.evidence.begin(manifest, label);
    if (!this.policy.canRecordPackage(device.foreground.packageName)) {
      session.pause('evidence began while the foreground package was unavailable or restrictive');
    }
    return session;
  }
}
