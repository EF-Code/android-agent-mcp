import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { compileBoundedRegex, validateSelector } from '../validation/selectors.js';
import type { UiMatch, UiNode, UiSelector, UiSnapshot } from './types.js';

function compareText(
  actual: string | null,
  expected: string,
  mode: UiSelector['textMode'],
  caseSensitive: boolean,
): boolean {
  if (actual === null) return false;
  const left = caseSensitive ? actual : actual.toLocaleLowerCase();
  const right = caseSensitive ? expected : expected.toLocaleLowerCase();
  switch (mode ?? 'exact') {
    case 'exact':
      return left === right;
    case 'contains':
      return left.includes(right);
    case 'regex':
      return compileBoundedRegex(caseSensitive ? expected : expected.toLocaleLowerCase()).test(
        left,
      );
  }
}

function matchesNode(
  node: UiNode,
  selector: UiSelector,
): { matched: boolean; score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const stringChecks: Array<{
    actual: string | null;
    expected: string | undefined;
    mode: UiSelector['textMode'];
    caseSensitive: boolean;
    weight: number;
    label: string;
  }> = [
    {
      actual: node.text,
      expected: selector.text,
      mode: selector.textMode,
      caseSensitive: selector.textCaseSensitive ?? true,
      weight: 100,
      label: 'text',
    },
    {
      actual: node.contentDescription,
      expected: selector.contentDescription,
      mode: selector.contentDescriptionMode,
      caseSensitive: selector.contentDescriptionCaseSensitive ?? true,
      weight: 95,
      label: 'contentDescription',
    },
  ];

  for (const check of stringChecks) {
    if (check.expected !== undefined) {
      if (!compareText(check.actual, check.expected, check.mode, check.caseSensitive)) {
        return { matched: false, score: 0, reasons: [] };
      }
      score += check.weight;
      reasons.push(`${check.label}:${check.mode ?? 'exact'}`);
    }
  }

  const exactChecks: Array<[string, string | null | undefined, string | null, number]> = [
    ['resourceId', selector.resourceId, node.resourceId, 110],
    ['className', selector.className, node.className, 35],
    ['packageName', selector.packageName, node.packageName, 30],
  ];
  for (const [label, expected, actual, weight] of exactChecks) {
    if (expected !== undefined) {
      if (actual !== expected) return { matched: false, score: 0, reasons: [] };
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
      if (node.flags[flag] !== expected) return { matched: false, score: 0, reasons: [] };
      score += 10;
      reasons.push(`${flag}:${expected}`);
    }
  }

  if (selector.nodeId !== undefined) {
    if (selector.nodeId !== node.nodeId) return { matched: false, score: 0, reasons: [] };
    score += 1_000;
    reasons.push('nodeId:exact');
  }

  return { matched: true, score, reasons };
}

function hasAncestor(snapshot: UiSnapshot, node: UiNode, selector: UiSelector): boolean {
  let parentId = node.parentId;
  while (parentId !== null) {
    const parent = snapshot.nodes.find((candidate) => candidate.nodeId === parentId);
    if (parent === undefined) return false;
    if (matchesNode(parent, selector).matched) return true;
    parentId = parent.parentId;
  }
  return false;
}

function hasDescendant(snapshot: UiSnapshot, node: UiNode, selector: UiSelector): boolean {
  const pending = [...node.childIds];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined) continue;
    const child = snapshot.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (child === undefined) continue;
    if (matchesNode(child, selector).matched) return true;
    pending.push(...child.childIds);
  }
  return false;
}

export function findMatches(snapshot: UiSnapshot, selector: UiSelector): UiMatch[] {
  validateSelector(selector);
  if (Object.keys(selector).length === 0) {
    throw new AppError(ErrorCode.InvalidSelector, 'At least one selector field is required.');
  }

  return snapshot.nodes
    .flatMap((node) => {
      const result = matchesNode(node, selector);
      if (!result.matched) return [];
      if (selector.ancestor !== undefined && !hasAncestor(snapshot, node, selector.ancestor))
        return [];
      if (selector.descendant !== undefined && !hasDescendant(snapshot, node, selector.descendant))
        return [];
      return [{ node, score: result.score, reasons: result.reasons }];
    })
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
