import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { parseUiAutomatorXml } from '../../src/ui/parse.js';
import { findMatches, resolveUniqueMatch } from '../../src/ui/selectors.js';

const display = { width: 1080, height: 2400, rotation: 0 as const };
const foreground = { packageName: 'com.example.app', activity: '.MainActivity', pid: 1234 };

function snapshot(xml: string) {
  return parseUiAutomatorXml(xml, {
    snapshotId: 'snapshot-1',
    capturedAt: new Date().toISOString(),
    display,
    foreground,
  });
}

test('normalizes hierarchy nodes, relations, centers, and password redaction', () => {
  const result = snapshot(
    `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][1080,2400]" enabled="true" visible-to-user="true"><node class="android.widget.EditText" package="com.example.app" text="secret-value" content-desc="secret-description" password="true" focused="true" enabled="true" bounds="[10,20][210,120]" resource-id="com.example.app:id/password"/><node class="android.widget.Button" package="com.example.app" text="Continue" clickable="true" enabled="true" bounds="[10,150][300,260]"/></node></hierarchy>`,
  );

  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[1]?.text, '[REDACTED]');
  assert.equal(result.nodes[1]?.contentDescription, '[REDACTED]');
  assert.equal(result.nodes[1]?.parentId, 'node-0');
  assert.deepEqual(result.nodes[2]?.center, { x: 155, y: 205 });
  assert.deepEqual(result.nodes[0]?.childIds, ['node-0.0', 'node-0.1']);
});

test('finds exact semantic elements and rejects equally strong ambiguity', () => {
  const result = snapshot(
    `<hierarchy><node class="android.widget.LinearLayout" package="com.example.app" bounds="[0,0][500,500]" enabled="true"><node class="android.widget.Button" package="com.example.app" text="Continue" clickable="true" enabled="true" bounds="[0,0][100,100]"/><node class="android.widget.Button" package="com.example.app" text="Continue" clickable="true" enabled="true" bounds="[100,0][200,100]"/></node></hierarchy>`,
  );
  const matches = findMatches(result, {
    text: 'continue',
    textCaseSensitive: false,
    clickable: true,
  });
  assert.equal(matches.length, 2);
  assert.throws(() => resolveUniqueMatch(result, { text: 'Continue', clickable: true }));
  assert.equal(
    resolveUniqueMatch(result, { text: 'Continue', clickable: true }, 1).node.nodeId,
    'node-0.1',
  );
});

test('warns about custom-rendered surfaces and malformed bounds', () => {
  const result = snapshot(
    `<hierarchy><node class="android.view.SurfaceView" package="com.example.app" bounds="bad" enabled="true"/></hierarchy>`,
  );
  assert.ok(result.warnings.some((warning) => warning.code === 'NON_SEMANTIC_SURFACE'));
  assert.ok(result.warnings.some((warning) => warning.code === 'MISSING_BOUNDS'));
});

test('matches strict ancestors and descendants, including nested relationships', () => {
  const result = snapshot(
    '<hierarchy><node text="Root"><node text="Panel" resource-id="panel"><node text="Continue" clickable="true"/></node><node text="Panel"><node text="Cancel"/></node></node></hierarchy>',
  );
  assert.deepEqual(
    findMatches(result, { text: 'Continue', ancestor: { text: 'Root' } }).map((m) => m.node.nodeId),
    ['node-0.0.0'],
  );
  assert.deepEqual(
    findMatches(result, {
      text: 'Panel',
      ancestor: { text: 'Root' },
      descendant: { text: 'Continue', clickable: true },
    }).map((m) => m.node.nodeId),
    ['node-0.0'],
  );
  assert.equal(findMatches(result, { text: 'Root', ancestor: { text: 'Root' } }).length, 0);
  assert.equal(
    findMatches(result, { text: 'Continue', descendant: { text: 'Continue' } }).length,
    0,
  );
  assert.equal(
    findMatches(result, {
      text: 'Continue',
      ancestor: { text: 'Panel', ancestor: { text: 'Missing' } },
    }).length,
    0,
  );
  assert.equal(
    findMatches(result, {
      text: 'Root',
      descendant: { text: 'Panel', descendant: { text: 'Missing' } },
    }).length,
    0,
  );
  assert.equal(
    findMatches(result, {
      text: 'Root',
      descendant: { text: 'Panel', descendant: { text: 'Continue' } },
    }).length,
    1,
  );
});

test('uses regex case flags without lowercasing regex escapes or negated classes', () => {
  const result = snapshot(
    '<hierarchy><node text="ABC" content-desc="Hello"/><node text="   "/></hierarchy>',
  );
  const matches = findMatches(result, {
    text: '^\\S+$',
    textMode: 'regex',
    textCaseSensitive: false,
    contentDescription: '^HELLO$',
    contentDescriptionMode: 'regex',
    contentDescriptionCaseSensitive: false,
  });
  assert.deepEqual(
    matches.map((m) => m.node.text),
    ['ABC'],
  );
  assert.equal(
    findMatches(result, { text: '^[A-Z]+$', textMode: 'regex', textCaseSensitive: false }).length,
    1,
  );
  assert.equal(findMatches(result, { text: '^abc$', textMode: 'regex' }).length, 0);
});

test('preserves match ordering, scoring, reasons, and ambiguity', () => {
  const result = snapshot(
    '<hierarchy><node text="Save" class="Button" enabled="true" clickable="true"/><node text="Save" class="Button" enabled="true" clickable="true"/></hierarchy>',
  );
  const selector = {
    text: 'ave',
    textMode: 'contains' as const,
    className: 'Button',
    enabled: true,
    clickable: true,
  };
  const matches = findMatches(result, selector);
  assert.deepEqual(
    matches.map((m) => m.node.nodeId),
    ['node-0', 'node-1'],
  );
  assert.equal(matches[0]?.score, 155);
  assert.deepEqual(matches[0]?.reasons, [
    'text:contains',
    'className:exact',
    'clickable:true',
    'enabled:true',
  ]);
  assert.throws(() => resolveUniqueMatch(result, selector), { code: ErrorCode.UiElementAmbiguous });
  assert.equal(resolveUniqueMatch(result, { ...selector, nodeId: 'node-1' }).score, 1155);
});

test('bounds cyclic relationships and ignores missing graph references', () => {
  const result = snapshot('<hierarchy><node text="A"/><node text="B"/></hierarchy>');
  const [a, b] = result.nodes;
  a!.parentId = b!.nodeId;
  b!.parentId = a!.nodeId;
  a!.childIds = [b!.nodeId, 'missing'];
  b!.childIds = [a!.nodeId];
  assert.equal(findMatches(result, { ancestor: { text: 'Missing' } }).length, 0);
  assert.equal(findMatches(result, { descendant: { text: 'Missing' } }).length, 0);
  assert.equal(findMatches(result, { text: 'A', ancestor: { text: 'B' } }).length, 1);
  assert.equal(findMatches(result, { text: 'B', descendant: { text: 'A' } }).length, 1);
  result.nodes.push({ ...a! });
  assert.throws(() => findMatches(result, { text: 'A' }), {
    code: ErrorCode.UiHierarchyIncomplete,
  });
});

test('validates relationship regexes even when no nodes match', () => {
  const result = snapshot('<hierarchy rotation="0"/>');
  assert.throws(
    () => findMatches(result, { text: 'Missing', ancestor: { text: '[', textMode: 'regex' } }),
    { code: ErrorCode.InvalidSelector },
  );
  assert.throws(() => findMatches(result, {}), { code: ErrorCode.InvalidSelector });
});
