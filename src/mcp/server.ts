import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerConfig } from '../config/types.js';
import { loadConfig } from '../config/loader.js';
import { asAppError } from '../errors/app-error.js';
import { fail, ok } from '../errors/result.js';
import { EvidenceSession } from '../evidence/recorder.js';
import { SERVER_INSTRUCTIONS } from '../instructions.js';
import { errorContent, imageContent, jsonContent } from './content.js';
import {
  appListSchema,
  appPackageSchema,
  captureSchema,
  clearDataSchema,
  coordinateSchema,
  emptySchema,
  evidenceBeginSchema,
  evidenceFinishSchema,
  evidenceNoteSchema,
  installSchema,
  keyPressSchema,
  logCaptureSchema,
  mirrorStartSchema,
  permissionSetSchema,
  serialSchema,
  swipeSchema,
  textTypeSchema,
  uiDumpSchema,
  uiFindSchema,
  uiTapSchema,
  waitForUiSchema,
} from './schemas.js';
import { AndroidDeviceService } from '../service.js';
import type { UiSelector } from '../ui/types.js';
import type { AllowedKey } from '../adb/input.js';

function toSelector(selector: unknown): UiSelector {
  return selector as UiSelector;
}

function toolError(error: unknown) {
  return errorContent(fail(error));
}

function registerReadOnlyTools(server: McpServer, service: AndroidDeviceService): void {
  server.registerTool('device_list', { description: 'List connected Android devices and their ADB authorization states.', inputSchema: emptySchema, annotations: { readOnlyHint: true } }, async () => {
    try { return jsonContent(ok(await service.devices.list())); } catch (error) { return toolError(error); }
  });

  server.registerTool('device_info', { description: 'Return normalized information for the selected device.', inputSchema: emptySchema, annotations: { readOnlyHint: true } }, async () => {
    try { return jsonContent(ok(await service.deviceInfo(), { deviceSerial: await service.selectedSerial() })); } catch (error) { return toolError(error); }
  });

  server.registerTool('mirror_status', { description: 'Return the status of the server-owned scrcpy process.', inputSchema: emptySchema, annotations: { readOnlyHint: true } }, async () => {
    try { return jsonContent(ok(service.scrcpy.status())); } catch (error) { return toolError(error); }
  });

  server.registerTool('screen_capture', { description: 'Capture a validated PNG screenshot from the selected device.', inputSchema: captureSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try {
      const serial = await service.selectedSerial();
      const screenshot = await service.screenshots.capture(serial);
      const observation = await service.screenObservation(serial);
      let evidenceDigest: unknown = null;
      if (args.save_to_evidence === true) {
        const session = service.evidence.requireActive();
        evidenceDigest = await session.saveScreenshot(args.label ?? 'screen', screenshot.png);
      }
      const result = ok({ width: screenshot.width, height: screenshot.height, rotation: observation.display.rotation, foreground: observation.foreground, sha256: screenshot.sha256, evidence: evidenceDigest }, { deviceSerial: serial });
      return imageContent(result, screenshot.png);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('ui_dump', { description: 'Capture and normalize the selected device UIAutomator hierarchy.', inputSchema: uiDumpSchema, annotations: { readOnlyHint: true } }, async () => {
    try {
      const snapshot = await service.captureUi();
      const data = { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, ...(node.flags.password ? { text: '[REDACTED]' } : {}) })) };
      return jsonContent(ok(data, { deviceSerial: await service.selectedSerial(), warnings: snapshot.warnings }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('ui_find', { description: 'Find matching elements in a fresh or retained UI snapshot.', inputSchema: uiFindSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try {
      const snapshot = args.snapshot_id === undefined ? await service.captureUi() : service.snapshots.requireFresh(args.snapshot_id, await service.currentForeground());
      const matches = (await import('../ui/selectors.js')).findMatches(snapshot, toSelector(args.selector));
      return jsonContent(ok({ snapshot_id: snapshot.snapshotId, matches }, { deviceSerial: await service.selectedSerial(), warnings: snapshot.warnings }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('app_list', { description: 'List bounded package metadata from the selected device.', inputSchema: appListSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try {
      const serial = await service.selectedSerial();
      const options = {
        ...(args.third_party === undefined ? {} : { thirdParty: args.third_party }),
        ...(args.system === undefined ? {} : { system: args.system }),
        ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
        ...(args.disabled === undefined ? {} : { disabled: args.disabled }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      };
      return jsonContent(ok(await service.packages.list(serial, options), { deviceSerial: serial }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('app_info', { description: 'Inspect metadata for an allowlisted package.', inputSchema: appPackageSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try { service.policy.assertPackageAllowed(args.package_name); return jsonContent(ok(await service.packages.info(await service.selectedSerial(), args.package_name), { deviceSerial: await service.selectedSerial() })); } catch (error) { return toolError(error); }
  });

  server.registerTool('permissions_list', { description: 'List requested and granted runtime permissions for an allowlisted package.', inputSchema: appPackageSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try { service.policy.assertPackageAllowed(args.package_name); return jsonContent(ok(await service.permissions.list(await service.selectedSerial(), args.package_name), { deviceSerial: await service.selectedSerial() })); } catch (error) { return toolError(error); }
  });

  server.registerTool('logcat_capture', { description: 'Capture bounded, filtered, and redacted logcat output.', inputSchema: logCaptureSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try {
      if (args.package_name !== undefined) service.policy.assertPackageAllowed(args.package_name);
      const serial = await service.selectedSerial();
      const options = {
        ...(args.package_name === undefined ? {} : { packageName: args.package_name }),
        ...(args.pid === undefined ? {} : { pid: args.pid }),
        ...(args.severity === undefined ? {} : { severity: args.severity }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.duration_ms === undefined ? {} : { durationMs: args.duration_ms }),
        ...(args.since === undefined ? {} : { since: args.since }),
        ...(args.max_lines === undefined ? {} : { maxLines: args.max_lines }),
        ...(args.max_bytes === undefined ? {} : { maxBytes: args.max_bytes }),
        ...(args.include_crash_buffer === undefined ? {} : { includeCrashBuffer: args.include_crash_buffer }),
      };
      return jsonContent(ok(await service.logcat.capture(serial, options), { deviceSerial: serial }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('logcat_crashes', { description: 'Return bounded recent crash and ANR evidence for an allowlisted package.', inputSchema: appPackageSchema, annotations: { readOnlyHint: true } }, async (args) => {
    try { service.policy.assertPackageAllowed(args.package_name); return jsonContent(ok(await service.logcat.crashes(await service.selectedSerial(), args.package_name), { deviceSerial: await service.selectedSerial() })); } catch (error) { return toolError(error); }
  });
}

function registerInteractiveTools(server: McpServer, service: AndroidDeviceService): void {
  server.registerTool('device_select', { description: 'Select one authorized Android device by exact serial.', inputSchema: serialSchema }, async (args) => {
    try { const result = await service.devices.select(args.serial); return jsonContent(ok(result, { deviceSerial: args.serial })); } catch (error) { return toolError(error); }
  });

  server.registerTool('mirror_start', { description: 'Start a visible server-owned scrcpy mirror for the selected device.', inputSchema: mirrorStartSchema }, async (args) => {
    try {
      const serial = await service.selectedSerial();
      return jsonContent(ok((await service.scrcpy.start(serial, {
        maxSize: args.max_size ?? service.config.mirror.maxSize,
        maxFps: args.max_fps ?? service.config.mirror.maxFps,
        audio: args.audio ?? service.config.mirror.audio,
        control: args.control ?? true,
        stayAwake: args.stay_awake ?? false,
        turnScreenOff: args.turn_screen_off ?? false,
        windowTitle: args.window_title ?? 'Android Device MCP',
      })).status, { deviceSerial: serial }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('mirror_stop', { description: 'Stop only the server-owned scrcpy mirror.', inputSchema: emptySchema }, async () => {
    try { return jsonContent(ok(await service.scrcpy.stop())); } catch (error) { return toolError(error); }
  });

  server.registerTool('ui_tap', { description: 'Tap one uniquely resolved visible semantic UI element and verify the result.', inputSchema: uiTapSchema }, async (args) => {
    try {
      if (args.selector === undefined && args.node_id === undefined) throw new Error('selector or node_id is required');
      const selector = args.selector === undefined ? { nodeId: args.node_id! } : toSelector(args.selector);
      const result = await service.tapSelector(selector, args.match_index, args.verify_change ?? true);
      return jsonContent(ok({ node_id: result.nodeId, before_snapshot_id: result.before.snapshotId, after_snapshot_id: result.after?.snapshotId ?? null, changed: result.after === null ? null : JSON.stringify(result.before.nodes) !== JSON.stringify(result.after.nodes) }, { deviceSerial: await service.selectedSerial(), warnings: result.after?.warnings ?? result.before.warnings }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('screen_tap', { description: 'Tap validated native device-pixel coordinates as a fallback.', inputSchema: coordinateSchema }, async (args) => {
    try { const result = await service.tapCoordinates(args.x, args.y, args.verify_change ?? true); return jsonContent(ok({ before_snapshot_id: result.before?.snapshotId ?? null, after_snapshot_id: result.after?.snapshotId ?? null, changed: result.before !== null && result.after !== null && JSON.stringify(result.before.nodes) !== JSON.stringify(result.after.nodes) }, { deviceSerial: await service.selectedSerial() })); } catch (error) { return toolError(error); }
  });

  server.registerTool('screen_swipe', { description: 'Perform a bounded native coordinate or deterministic directional swipe.', inputSchema: swipeSchema }, async (args) => {
    try {
      const options = {
        ...(args.start_x === undefined ? {} : { startX: args.start_x }),
        ...(args.start_y === undefined ? {} : { startY: args.start_y }),
        ...(args.end_x === undefined ? {} : { endX: args.end_x }),
        ...(args.end_y === undefined ? {} : { endY: args.end_y }),
        ...(args.direction === undefined ? {} : { direction: args.direction }),
        ...(args.duration_ms === undefined ? {} : { durationMs: args.duration_ms }),
        verifyChange: args.verify_change ?? true,
      };
      const result = await service.swipe(options);
      return jsonContent(ok({ before_snapshot_id: result.before?.snapshotId ?? null, after_snapshot_id: result.after?.snapshotId ?? null }, { deviceSerial: await service.selectedSerial() }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('screen_long_press', { description: 'Perform a bounded stationary long press.', inputSchema: { ...coordinateSchema, duration_ms: z.number().int().min(250).max(30_000).optional() } }, async (args) => {
    try { const serial = await service.selectedSerial(); await service.longPress(args.x, args.y, args.duration_ms ?? 750); return jsonContent(ok({ x: args.x, y: args.y, duration_ms: args.duration_ms ?? 750 }, { deviceSerial: serial })); } catch (error) { return toolError(error); }
  });

  server.registerTool('key_press', { description: 'Press an allowlisted Android testing key.', inputSchema: keyPressSchema }, async (args) => {
    try { const serial = await service.selectedSerial(); await service.input.key(serial, args.key as AllowedKey, args.allow_power ?? false); return jsonContent(ok({ key: args.key }, { deviceSerial: serial })); } catch (error) { return toolError(error); }
  });

  server.registerTool('text_type', { description: 'Type safe printable ASCII test text into the focused field; never use for secrets.', inputSchema: textTypeSchema }, async (args) => {
    try { const foreground = await service.currentForeground(); if (foreground.packageName === null) throw new Error('No foreground package is observable'); service.policy.assertPackageAllowed(foreground.packageName); const snapshot = await service.captureUi(); if (snapshot.nodes.some((node) => node.flags.focused && node.flags.password)) throw new Error('Typing into password fields is blocked'); const count = await service.input.text(await service.selectedSerial(), args.text); return jsonContent(ok({ character_count: count }, { deviceSerial: await service.selectedSerial() })); } catch (error) { return toolError(error); }
  });

  server.registerTool('app_launch', { description: 'Launch an allowlisted package and verify it becomes foreground.', inputSchema: appPackageSchema }, async (args) => {
    try {
      service.policy.assertPackageAllowed(args.package_name);
      const serial = await service.selectedSerial();
      const started = performance.now();
      const launch = await service.packages.launch(serial, args.package_name);
      await service.stabilize();
      const foreground = await service.verifyForeground(args.package_name);
      const crashes = await service.logcat.crashes(serial, args.package_name, 100);
      return jsonContent(ok({ ...launch, startup_ms: Math.round(performance.now() - started), foreground, immediate_crashes: crashes }, { deviceSerial: serial }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('app_stop', { description: 'Force-stop an allowlisted package.', inputSchema: appPackageSchema }, async (args) => {
    try { service.policy.assertPackageAllowed(args.package_name); const serial = await service.selectedSerial(); await service.packages.stop(serial, args.package_name); return jsonContent(ok({ package_name: args.package_name, stopped: true }, { deviceSerial: serial })); } catch (error) { return toolError(error); }
  });

  server.registerTool('wait_for_ui', { description: 'Poll for a bounded UI, foreground, disappearance, or screen-change condition.', inputSchema: waitForUiSchema }, async (args) => {
    try {
      if (args.package_name !== undefined) service.policy.assertPackageAllowed(args.package_name);
      const options = {
        ...(args.selector === undefined ? {} : { selector: toSelector(args.selector) }),
        ...(args.package_name === undefined ? {} : { packageName: args.package_name }),
        ...(args.activity === undefined ? {} : { activity: args.activity }),
        ...(args.disappearance === undefined ? {} : { disappearance: args.disappearance }),
        ...(args.screen_change === undefined ? {} : { screenChange: args.screen_change }),
        timeoutMs: args.timeout_ms ?? 15_000,
        pollMs: args.poll_ms ?? 500,
      };
      return jsonContent(ok(await service.waitForUi(options), { deviceSerial: await service.selectedSerial() }));
    } catch (error) { return toolError(error); }
  });
}

function registerMutationTools(server: McpServer, service: AndroidDeviceService): void {
  server.registerTool('app_install', { description: 'Approval-required installation of an APK under an allowed host root.', inputSchema: installSchema }, async (args) => {
    try { service.policy.assertApproval(args.approved, 'app_install'); const serial = await service.selectedSerial(); const apk = await service.installer.validate(args.path); return jsonContent(ok(await service.installer.install(serial, apk, args.replace ?? false), { deviceSerial: serial })); } catch (error) { return toolError(error); }
  });

  server.registerTool('app_clear_data', { description: 'Approval-required irreversible clearing of local data for an allowlisted test package.', inputSchema: clearDataSchema }, async (args) => {
    try { service.policy.assertApproval(args.approved, 'app_clear_data'); service.policy.assertPackageAllowed(args.package_name); const serial = await service.selectedSerial(); const output = await service.packages.clearData(serial, args.package_name); return jsonContent(ok({ package_name: args.package_name, output, irreversible: true }, { deviceSerial: serial })); } catch (error) { return toolError(error); }
  });

  server.registerTool('permissions_set', { description: 'Approval-required grant or revoke of a requested runtime permission.', inputSchema: permissionSetSchema }, async (args) => {
    try { service.policy.assertApproval(args.approved, 'permissions_set'); service.policy.assertPackageAllowed(args.package_name); const serial = await service.selectedSerial(); await service.permissions.set(serial, args.package_name, args.permission, args.action); return jsonContent(ok({ package_name: args.package_name, permission: args.permission, action: args.action }, { deviceSerial: serial })); } catch (error) { return toolError(error); }
  });
}

function registerEvidenceTools(server: McpServer, service: AndroidDeviceService): void {
  server.registerTool('evidence_begin', { description: 'Begin a sanitized, bounded local evidence session.', inputSchema: evidenceBeginSchema }, async (args) => {
    try { const session = await service.beginEvidence(args.label, args.metadata); return jsonContent(ok(session.summary)); } catch (error) { return toolError(error); }
  });
  server.registerTool('evidence_note', { description: 'Add a redacted note to the active evidence session.', inputSchema: evidenceNoteSchema }, async (args) => {
    try { const session: EvidenceSession = service.evidence.requireActive(); await session.note(args.message, args.details); return jsonContent(ok({ evidence_id: session.evidenceId })); } catch (error) { return toolError(error); }
  });
  server.registerTool('evidence_finish', { description: 'Finish the active evidence session and write its summary.', inputSchema: evidenceFinishSchema }, async () => {
    try { return jsonContent(ok(await service.evidence.finish())); } catch (error) { return toolError(error); }
  });
}

export function createMcpServer(config: ServerConfig = loadConfig()): { server: McpServer; service: AndroidDeviceService } {
  const service = new AndroidDeviceService(config);
  const server = new McpServer({ name: 'android-device', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerReadOnlyTools(server, service);
  registerInteractiveTools(server, service);
  registerMutationTools(server, service);
  registerEvidenceTools(server, service);
  return { server, service };
}

export { asAppError };
