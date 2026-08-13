import type { DisplayInfo, ForegroundApp, Warning } from '../types.js';

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiNodeFlags {
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  selected: boolean;
  checked: boolean;
  password: boolean;
  visibleToUser: boolean;
}

export interface UiNode {
  nodeId: string;
  className: string | null;
  packageName: string | null;
  text: string | null;
  contentDescription: string | null;
  resourceId: string | null;
  flags: UiNodeFlags;
  bounds: Bounds | null;
  center: { x: number; y: number } | null;
  parentId: string | null;
  childIds: string[];
}

export interface UiSnapshot {
  snapshotId: string;
  deviceSerial?: string;
  deviceSessionId?: string;
  capturedAt: string;
  display: DisplayInfo;
  foreground: ForegroundApp;
  nodes: UiNode[];
  rootIds: string[];
  warnings: Warning[];
}

export type SelectorMatchMode = 'exact' | 'contains' | 'regex';

export interface UiSelector {
  nodeId?: string;
  text?: string;
  textMode?: SelectorMatchMode;
  textCaseSensitive?: boolean;
  contentDescription?: string;
  contentDescriptionMode?: SelectorMatchMode;
  contentDescriptionCaseSensitive?: boolean;
  resourceId?: string;
  className?: string;
  packageName?: string;
  clickable?: boolean;
  enabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  scrollable?: boolean;
  selected?: boolean;
  checked?: boolean;
  password?: boolean;
  ancestor?: UiSelector;
  descendant?: UiSelector;
}

export interface UiMatch {
  node: UiNode;
  score: number;
  reasons: string[];
}
