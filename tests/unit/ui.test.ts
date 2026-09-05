import assert from 'node:assert/strict';
import test from 'node:test';

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
