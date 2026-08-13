import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { AppError } from '../../src/errors/app-error.js';
import { Policy } from '../../src/policy/policy.js';
import { isSpecialPermission } from '../../src/adb/permissions.js';
import { redactLogText, redactSensitiveUiText, redactUiText, REDACTED } from '../../src/policy/redaction.js';
import { validateSelector } from '../../src/validation/selectors.js';
import { defaultConfig } from '../../src/config/defaults.js';

test('redacts common credentials, emails, and password node text', () => {
  const redacted = redactLogText('Authorization: Bearer abcdefgh; token=secret-value; owner@example.com');
  assert.ok(!redacted.includes('abcdefgh'));
  assert.ok(!redacted.includes('secret-value'));
  assert.ok(redacted.includes(REDACTED));
  assert.equal(redactUiText('secret', true), REDACTED);
  assert.equal(redactUiText('visible', false), 'visible');
  assert.equal(redactSensitiveUiText('visible'), REDACTED);
});

test('enforces package allowlist, sensitive patterns, and host mutation approval', () => {
  const config = { ...defaultConfig(), allowedPackages: ['com.example.*'] };
  const policy = new Policy(config);
  assert.doesNotThrow(() => policy.assertPackageAllowed('com.example.app'));
  assert.throws(() => policy.assertPackageAllowed('com.other.app'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.PackageNotAllowed);
  assert.throws(() => policy.assertPackageAllowed('com.android.settings'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.SensitivePackage);
  assert.throws(() => policy.assertMutationAllowed('app_install'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.ApprovalRequired);
  assert.doesNotThrow(() => new Policy({ ...config, approvalMode: 'allow' }).assertMutationAllowed('app_install'));
});

test('requires an authorized, non-sensitive foreground package for observations', () => {
  const policy = new Policy({ ...defaultConfig(), allowedPackages: ['com.example.*'] });
  assert.equal(policy.assertObservationAllowed({ packageName: 'com.example.app', activity: '.Main', pid: 1 }, 'capture'), 'com.example.app');
  assert.throws(() => policy.assertObservationAllowed({ packageName: null, activity: null, pid: null }, 'capture'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.ForegroundUnknown);
  assert.throws(() => policy.assertObservationAllowed({ packageName: 'com.android.settings', activity: '.Settings', pid: 2 }, 'capture'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.SensitivePackage);
});

test('rejects Android special-access and policy-level permissions', () => {
  for (const permission of [
    'android.permission.REQUEST_INSTALL_PACKAGES',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.BIND_ACCESSIBILITY_SERVICE',
    'android.permission.BIND_VPN_SERVICE',
    'android.permission.MANAGE_EXTERNAL_STORAGE',
    'android.permission.INTERACT_ACROSS_USERS_FULL',
  ]) {
    assert.equal(isSpecialPermission(permission), true, permission);
  }
  assert.equal(isSpecialPermission('android.permission.CAMERA'), false);
});

test('rejects unsafe selector regexes and deeply nested relationships', () => {
  assert.throws(() => validateSelector({ text: '(a+)+', textMode: 'regex' }));
  let selector = { text: 'leaf' };
  for (let index = 0; index < 6; index += 1) selector = { text: 'parent', descendant: selector } as typeof selector;
  assert.throws(() => validateSelector(selector));
});
