import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { compileBoundedRegex, validateSelector } from '../validation/selectors.js';
import type { UiMatch, UiNode, UiSelector, UiSnapshot } from './types.js';

function compileTextCheck(
  expected: string,
  mode: UiSelector['textMode'],
  caseSensitive: boolean,
): (actual: string | null) => boolean {
  if (mode === 'regex') {
    const regex = compileBoundedRegex(expected, caseSensitive);
    return (actual) => actual !== null && regex.test(actual);
  }
  const right = caseSensitive ? expected : expected.toLocaleLowerCase();
  return (actual) => {
    if (actual === null) return false;
    const left = caseSensitive ? actual : actual.toLocaleLowerCase();
    return mode === 'contains' ? left.includes(right) : left === right;
  };
}

function compileNodeMatcher(selector: UiSelector): {
  matches: (node: UiNode) => boolean;
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const checks: Array<(node: UiNode) => boolean> = [];
  const stringChecks: Array<{
    field: 'text' | 'contentDescription';
    expected: string | undefined;
    mode: UiSelector['textMode'];
    caseSensitive: boolean;
    weight: number;
    label: string;
  }> = [
    {
      field: 'text',
      expected: selector.text,
      mode: selector.textMode,
      caseSensitive: selector.textCaseSensitive ?? true,
      weight: 100,
      label: 'text',
    },
    {
      field: 'contentDescription',
      expected: selector.contentDescription,
      mode: selector.contentDescriptionMode,
      caseSensitive: selector.contentDescriptionCaseSensitive ?? true,
      weight: 95,
      label: 'contentDescription',
    },
  ];

  for (const check of stringChecks) {
    if (check.expected !== undefined) {
      const matchesText = compileTextCheck(check.expected, check.mode, check.caseSensitive);
      checks.push((node) => matchesText(node[check.field]));
      score += check.weight;
      reasons.push(`${check.label}:${check.mode ?? 'exact'}`);
    }
  }

  const exactChecks: Array<
    ['resourceId' | 'className' | 'packageName', string | undefined, number]
  > = [
    ['resourceId', selector.resourceId, 110],
    ['className', selector.className, 35],
    ['packageName', selector.packageName, 30],
  ];
  for (const [label, expected, weight] of exactChecks) {
    if (expected !== undefined) {
      checks.push((node) => node[label] === expected);
      score += weight;
      reasons.push(`${label}:exact`);
    }
  }

  const flagChecks: Array<[keyof UiNode['flags'], boolean | undefined]> = [
    ['clickable', selector.clickable],
    ['enabled', selector.enabled],
    ['focusable', selector.focusable],
    ['focused', selector.focused],
    ['scrollable', selector.scrollable],
    ['selected', selector.selected],
    ['checked', selector.checked],
    ['password', selector.password],
  ];
  for (const [flag, expected] of flagChecks) {
    if (expected !== undefined) {
      checks.push((node) => node.flags[flag] === expected);
      score += 10;
      reasons.push(`${flag}:${expected}`);
    }
  }

  if (selector.nodeId !== undefined) {
    checks.push((node) => selector.nodeId === node.nodeId);
    score += 1_000;
    reasons.push('nodeId:exact');
  }

  return { matches: (node) => checks.every((check) => check(node)), score, reasons };
}

interface HierarchyIndex {
  nodes: Map<string, UiNode>;
  childrenByParent: Map<string, string[]>;
  parentsByChild: Map<string, string[]>;
}

function addEdge(edges: Map<string, string[]>, from: string, to: string): void {
  const existing = edges.get(from);
  if (existing === undefined) edges.set(from, [to]);
  else existing.push(to);
}

function indexHierarchy(snapshot: UiSnapshot): HierarchyIndex {
  const index: HierarchyIndex = {
    nodes: new Map(),
    childrenByParent: new Map(),
    parentsByChild: new Map(),
  };
  for (const node of snapshot.nodes) {
    if (index.nodes.has(node.nodeId)) {
      throw new AppError(ErrorCode.UiHierarchyIncomplete, 'UI node IDs must be unique.');
    }
    index.nodes.set(node.nodeId, node);
    if (node.parentId !== null) addEdge(index.childrenByParent, node.parentId, node.nodeId);
    for (const childId of node.childIds) addEdge(index.parentsByChild, childId, node.nodeId);
  }
  return index;
}

// Propagate relationship matches once per selector instead of walking the same
// subtrees for every candidate. Visited IDs also bound malformed cyclic graphs.
function relatedIds(
  matches: Set<string>,
  edges: Map<string, string[]>,
  index: HierarchyIndex,
): Set<string> {
  const related = new Set<string>();
  const pending = [...matches];
  const expanded = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (expanded.has(nodeId)) continue;
    expanded.add(nodeId);
    for (const nextId of edges.get(nodeId) ?? []) {
      if (!index.nodes.has(nextId)) continue;
      related.add(nextId);
      if (!expanded.has(nextId)) pending.push(nextId);
    }
  }
  return related;
}

function evaluateSelector(selector: UiSelector, index: HierarchyIndex) {
  const matcher = compileNodeMatcher(selector);
  const ancestors =
    selector.ancestor === undefined
      ? null
      : relatedIds(evaluateSelector(selector.ancestor, index).ids, index.childrenByParent, index);
  const descendants =
    selector.descendant === undefined
      ? null
      : relatedIds(evaluateSelector(selector.descendant, index).ids, index.parentsByChild, index);
  const ids = new Set<string>();
  for (const node of index.nodes.values()) {
    if (
      (ancestors === null || ancestors.has(node.nodeId)) &&
      (descendants === null || descendants.has(node.nodeId)) &&
      matcher.matches(node)
    ) {
      ids.add(node.nodeId);
    }
  }
  return { ids, score: matcher.score, reasons: matcher.reasons };
}

export function findMatches(snapshot: UiSnapshot, selector: UiSelector): UiMatch[] {
  validateSelector(selector);
  if (Object.keys(selector).length === 0) {
    throw new AppError(ErrorCode.InvalidSelector, 'At least one selector field is required.');
  }

  const result = evaluateSelector(selector, indexHierarchy(snapshot));
  return snapshot.nodes
    .filter((node) => result.ids.has(node.nodeId))
    .map((node) => ({ node, score: result.score, reasons: [...result.reasons] }))
    .sort(
      (left, right) =>
        right.score - left.score || left.node.nodeId.localeCompare(right.node.nodeId),
    );
}

export function resolveUniqueMatch(
  snapshot: UiSnapshot,
  selector: UiSelector,
  matchIndex?: number,
): UiMatch {
  const matches = findMatches(snapshot, selector);
  if (matches.length === 0) {
    throw new AppError(ErrorCode.UiElementNotFound, 'No UI element matched the selector.', {
      retryable: true,
    });
  }

  if (matchIndex !== undefined) {
    if (!Number.isInteger(matchIndex) || matchIndex < 0 || matchIndex >= matches.length) {
      throw new AppError(
        ErrorCode.InvalidInput,
        'matchIndex is outside the available match list.',
        {
          details: { matchCount: matches.length, matchIndex },
        },
      );
    }
    return matches[matchIndex]!;
  }

  const bestScore = matches[0]!.score;
  const strongest = matches.filter((match) => match.score === bestScore);
  if (strongest.length !== 1) {
    throw new AppError(
      ErrorCode.UiElementAmbiguous,
      'The selector matched multiple equally strong UI elements.',
      {
        retryable: true,
        details: {
          matches: strongest.map((match) => ({
            nodeId: match.node.nodeId,
            bounds: match.node.bounds,
            score: match.score,
            reasons: match.reasons,
          })),
        },
      },
    );
  }

  return strongest[0]!;
}
