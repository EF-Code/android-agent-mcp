import { z } from 'zod';

export const emptySchema = {} as const;

export const serialSchema = { serial: z.string().min(1).max(128) };

export const mirrorStartSchema = {
  max_size: z.number().int().min(240).max(8_000).optional(),
  max_fps: z.number().int().min(1).max(120).optional(),
  audio: z.boolean().optional(),
  control: z.boolean().optional(),
  stay_awake: z.boolean().optional(),
  turn_screen_off: z.boolean().optional(),
  window_title: z.string().min(1).max(120).optional(),
};

export const captureSchema = {
  save_to_evidence: z.boolean().optional(),
  label: z.string().min(1).max(64).optional(),
};

export const uiDumpSchema = {
  compact: z.boolean().optional(),
};

const selectorMode = z.enum(['exact', 'contains', 'regex']).optional();

export const selectorSchema: z.ZodTypeAny = z.object({
  nodeId: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(512).optional(),
  textMode: selectorMode,
  textCaseSensitive: z.boolean().optional(),
  contentDescription: z.string().min(1).max(512).optional(),
  contentDescriptionMode: selectorMode,
  contentDescriptionCaseSensitive: z.boolean().optional(),
  resourceId: z.string().min(1).max(512).optional(),
  className: z.string().min(1).max(512).optional(),
  packageName: z.string().min(1).max(255).optional(),
  clickable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  focusable: z.boolean().optional(),
  focused: z.boolean().optional(),
  scrollable: z.boolean().optional(),
  selected: z.boolean().optional(),
  checked: z.boolean().optional(),
  password: z.boolean().optional(),
  ancestor: z.lazy(() => selectorSchema).optional(),
  descendant: z.lazy(() => selectorSchema).optional(),
});

export const uiFindSchema = {
  selector: selectorSchema,
  snapshot_id: z.string().min(1).max(128).optional(),
};

export const uiTapSchema = {
  selector: selectorSchema.optional(),
  node_id: z.string().min(1).max(128).optional(),
  snapshot_id: z.string().min(1).max(128).optional(),
  match_index: z.number().int().min(0).max(100).optional(),
  verify_change: z.boolean().optional(),
  verify_pixels: z.boolean().optional(),
};

export const coordinateSchema = {
  x: z.number().int().min(0).max(100_000),
  y: z.number().int().min(0).max(100_000),
  coordinate_space: z.literal('device_pixels').optional(),
  verify_change: z.boolean().optional(),
  verify_pixels: z.boolean().optional(),
  settle_ms: z.number().int().min(0).max(2_000).optional(),
  include_screenshot: z.boolean().optional(),
};

export const swipeSchema = {
  start_x: z.number().int().min(0).max(100_000).optional(),
  start_y: z.number().int().min(0).max(100_000).optional(),
  end_x: z.number().int().min(0).max(100_000).optional(),
  end_y: z.number().int().min(0).max(100_000).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  duration_ms: z.number().int().min(0).max(30_000).optional(),
  verify_change: z.boolean().optional(),
  verify_pixels: z.boolean().optional(),
  settle_ms: z.number().int().min(0).max(2_000).optional(),
  include_screenshot: z.boolean().optional(),
};

const inputSequenceActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tap'),
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
  }),
  z.object({
    type: z.literal('swipe'),
    start_x: z.number().int().min(0).max(100_000),
    start_y: z.number().int().min(0).max(100_000),
    end_x: z.number().int().min(0).max(100_000),
    end_y: z.number().int().min(0).max(100_000),
    duration_ms: z.number().int().min(0).max(30_000),
  }),
  z.object({
    type: z.literal('key'),
    key: z.enum([
      'back',
      'home',
      'enter',
      'tab',
      'escape',
      'delete',
      'arrow_up',
      'arrow_down',
      'arrow_left',
      'arrow_right',
      'menu',
      'app_switch',
      'volume_up',
      'volume_down',
    ]),
  }),
]);

const visualCoordinateSpaceSchema = z.enum(['device_pixels', 'normalized_1000']);

export const visualControlStartSchema = {
  coordinate_space: visualCoordinateSpaceSchema.optional(),
};

export const visualControlActionSchema = {
  session_id: z.string().uuid(),
  actions: z.array(inputSequenceActionSchema).min(1).max(32),
  coordinate_space: visualCoordinateSpaceSchema.optional(),
  inter_action_delay_ms: z.number().int().min(0).max(1_000).optional(),
  settle_ms: z.number().int().min(0).max(2_000).optional(),
  wait_for_change_ms: z.number().int().min(0).max(15_000).optional(),
  stable_ms: z.number().int().min(0).max(2_000).optional(),
  poll_ms: z.number().int().min(50).max(1_000).optional(),
};

export const visualControlStopSchema = {
  session_id: z.string().uuid(),
};

export const inputSequenceSchema = {
  actions: z.array(inputSequenceActionSchema).min(1).max(32),
  inter_action_delay_ms: z.number().int().min(0).max(1_000).optional(),
  verify_change: z.boolean().optional(),
  verify_pixels: z.boolean().optional(),
  settle_ms: z.number().int().min(0).max(2_000).optional(),
  include_screenshot: z.boolean().optional(),
};

export const keyPressSchema = {
  key: z.enum([
    'back',
    'home',
    'enter',
    'tab',
    'escape',
    'delete',
    'arrow_up',
    'arrow_down',
    'arrow_left',
    'arrow_right',
    'menu',
    'app_switch',
    'volume_up',
    'volume_down',
  ]),
  verify_change: z.boolean().optional(),
  verify_pixels: z.boolean().optional(),
  settle_ms: z.number().int().min(0).max(2_000).optional(),
  include_screenshot: z.boolean().optional(),
};

export const textTypeSchema = {
  text: z.string().min(1).max(1_024),
};

export const appPackageSchema = {
  package_name: z.string().min(1).max(255),
};

export const appListSchema = {
  third_party: z.boolean().optional(),
  system: z.boolean().optional(),
  enabled: z.boolean().optional(),
  disabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(2_000).optional(),
};

export const installSchema = {
  path: z.string().min(1),
  replace: z.boolean().optional(),
};

export const clearDataSchema = {
  package_name: z.string().min(1).max(255),
};

export const permissionSetSchema = {
  package_name: z.string().min(1).max(255),
  permission: z.string().min(1).max(255),
  action: z.enum(['grant', 'revoke']),
};

export const logCaptureSchema = {
  package_name: z.string().min(1).max(255).optional(),
  pid: z.number().int().min(1).max(10_000_000).optional(),
  severity: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  duration_ms: z.number().int().min(0).max(30_000).optional(),
  since: z.string().min(1).max(64).optional(),
  max_lines: z.number().int().min(1).max(20_000).optional(),
  max_bytes: z.number().int().min(1_024).max(50_000_000).optional(),
  include_crash_buffer: z.boolean().optional(),
};

export const waitForUiSchema = {
  selector: selectorSchema.optional(),
  package_name: z.string().min(1).max(255).optional(),
  activity: z.string().min(1).max(512).optional(),
  disappearance: z.boolean().optional(),
  screen_change: z.boolean().optional(),
  timeout_ms: z.number().int().min(250).max(60_000).optional(),
  poll_ms: z.number().int().min(100).max(5_000).optional(),
};

export const evidenceBeginSchema = {
  label: z.string().min(1).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const evidenceNoteSchema = {
  message: z.string().min(1).max(2_000),
  details: z.record(z.string(), z.unknown()).optional(),
};

export const evidenceFinishSchema = {} as const;
