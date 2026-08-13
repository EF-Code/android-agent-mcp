import { XMLParser } from 'fast-xml-parser';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { redactUiText } from '../policy/redaction.js';
import type { DisplayInfo, ForegroundApp, Warning } from '../types.js';
import type { Bounds, UiNode, UiNodeFlags, UiSnapshot } from './types.js';

interface XmlRecord {
  [key: string]: unknown;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === 'node',
});

function asRecord(value: unknown): XmlRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as XmlRecord) : null;
}

function asNodeArray(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) return value.flatMap((item) => (asRecord(item) === null ? [] : [asRecord(item)!]));
  const record = asRecord(value);
  return record === null ? [] : [record];
}

function attribute(record: XmlRecord, name: string): string | null {
  const value = record[`@_${name}`];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function booleanAttribute(record: XmlRecord, name: string): boolean {
  return attribute(record, name) === 'true';
}

function parseBounds(value: string | null): Bounds | null {
  if (value === null) return null;
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (match === null) return null;
  const [, left, top, right, bottom] = match;
  const parsed = {
    left: Number(left),
    top: Number(top),
    right: Number(right),
    bottom: Number(bottom),
  };
  if (
    !Object.values(parsed).every((coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0) ||
    parsed.right <= parsed.left ||
    parsed.bottom <= parsed.top
  ) {
    return null;
  }
  return parsed;
}

function flags(record: XmlRecord): UiNodeFlags {
  return {
    clickable: booleanAttribute(record, 'clickable'),
    enabled: booleanAttribute(record, 'enabled'),
    focusable: booleanAttribute(record, 'focusable'),
    focused: booleanAttribute(record, 'focused'),
    scrollable: booleanAttribute(record, 'scrollable'),
    selected: booleanAttribute(record, 'selected'),
    checked: booleanAttribute(record, 'checked'),
    password: booleanAttribute(record, 'password'),
    visibleToUser: booleanAttribute(record, 'visible-to-user'),
  };
}

function addWarning(warnings: Warning[], warning: Warning): void {
  if (!warnings.some((existing) => existing.code === warning.code)) warnings.push(warning);
}

export function parseUiAutomatorXml(
  xml: string,
  options: {
    snapshotId: string;
    deviceSerial?: string;
    deviceSessionId?: string;
    capturedAt: string;
    display: DisplayInfo;
    foreground: ForegroundApp;
  },
): UiSnapshot {
  if (xml.length === 0 || xml.length > 50_000_000) {
    throw new AppError(ErrorCode.UiHierarchyIncomplete, 'UIAutomator XML is empty or exceeds the safety limit.', {
      details: { bytes: Buffer.byteLength(xml), maximumBytes: 50_000_000 },
    });
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new AppError(ErrorCode.UiHierarchyIncomplete, 'UIAutomator XML could not be parsed.', { cause: error });
  }

  const root = asRecord(parsed);
  const hierarchy = root === null ? null : asRecord(root.hierarchy);
  if (hierarchy === null) {
    throw new AppError(ErrorCode.UiHierarchyIncomplete, 'UIAutomator XML did not contain a hierarchy root.');
  }

  const nodes: UiNode[] = [];
  const rootIds: string[] = [];
  const warnings: Warning[] = [];
  const hierarchyRotation = attribute(hierarchy, 'rotation');
  if (hierarchyRotation !== null && !['0', '1', '2', '3'].includes(hierarchyRotation)) {
    addWarning(warnings, {
      code: 'INVALID_ROTATION',
      message: 'UIAutomator reported an unsupported display rotation.',
      details: { rotation: hierarchyRotation },
    });
  }

  const walk = (record: XmlRecord, parentId: string | null, path: string): string => {
    const nodeId = `node-${path}`;
    const nodeFlags = flags(record);
    const className = attribute(record, 'class');
    const packageName = attribute(record, 'package');
    const text = redactUiText(attribute(record, 'text'), nodeFlags.password);
    const contentDescription = attribute(record, 'content-desc');
    const resourceId = attribute(record, 'resource-id');
    const bounds = parseBounds(attribute(record, 'bounds'));
    const childIds: string[] = [];
    const node: UiNode = {
      nodeId,
      className,
      packageName,
      text,
      contentDescription,
      resourceId,
      flags: nodeFlags,
      bounds,
      center: bounds === null ? null : { x: Math.floor((bounds.left + bounds.right) / 2), y: Math.floor((bounds.top + bounds.bottom) / 2) },
      parentId,
      childIds,
    };
    nodes.push(node);

    if (bounds === null) {
      addWarning(warnings, {
        code: 'MISSING_BOUNDS',
        message: 'One or more UI nodes did not provide valid bounds.',
      });
    }

    if (className !== null && /(?:WebView|SurfaceView|TextureView|ComposeView|GLSurfaceView|Canvas)/u.test(className)) {
      addWarning(warnings, {
        code: 'NON_SEMANTIC_SURFACE',
        message: 'The hierarchy contains a web, video, graphics, or custom-rendered surface that may be incomplete.',
        details: { className },
      });
    }

    const children = asNodeArray(record.node);
    for (const [index, child] of children.entries()) {
      childIds.push(walk(child, nodeId, `${path}.${index}`));
    }

    return nodeId;
  };

  for (const [index, node] of asNodeArray(hierarchy.node).entries()) {
    rootIds.push(walk(node, null, `${index}`));
  }

  if (nodes.length === 0) {
    addWarning(warnings, {
      code: 'EMPTY_HIERARCHY',
      message: 'UIAutomator returned no nodes; custom canvases and protected surfaces may be invisible to this API.',
    });
  }

  return {
    snapshotId: options.snapshotId,
    ...(options.deviceSerial === undefined ? {} : { deviceSerial: options.deviceSerial }),
    ...(options.deviceSessionId === undefined ? {} : { deviceSessionId: options.deviceSessionId }),
    capturedAt: options.capturedAt,
    display: options.display,
    foreground: options.foreground,
    nodes,
    rootIds,
    warnings,
  };
}
