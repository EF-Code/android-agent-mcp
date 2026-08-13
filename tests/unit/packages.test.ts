import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePackageEntries, parsePackageLines } from '../../src/adb/packages.js';

test('parses package manager output with and without install paths', () => {
  assert.deepEqual(
    parsePackageEntries(`package:/system/priv-app/Settings/Settings.apk=com.android.settings
package:/data/app/~~abc/com.example.app/base.apk=com.example.app
package:com.example.noPath
garbage`),
    [
      { packageName: 'com.android.settings', sourcePath: '/system/priv-app/Settings/Settings.apk' },
      { packageName: 'com.example.app', sourcePath: '/data/app/~~abc/com.example.app/base.apk' },
      { packageName: 'com.example.noPath', sourcePath: null },
    ],
  );
  assert.deepEqual(parsePackageLines('package:com.example.app\npackage:com.example.other\n'), [
    'com.example.app',
    'com.example.other',
  ]);
});
