import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { AppError } from '../../src/errors/app-error.js';
import { Policy } from '../../src/policy/policy.js';
import { redactLogText, redactUiText, REDACTED } from '../../src/policy/redaction.js';
import { validateSelector } from '../../src/validation/selectors.js';
import { defaultConfig } from '../../src/config/defaults.js';

test('redacts common credentials, emails, and password node text', () => {
  const redacted = redactLogText('Authorization: Bearer abcdefgh; token=secret-value; owner@example.com');
  assert.ok(!redacted.includes('abcdefgh'));
  assert.ok(!redacted.includes('secret-value'));
  assert.ok(redacted.includes(REDACTED));
  assert.equal(redactUiText('secret', true), REDACTED);
  assert.equal(redactUiText('visible', false), 'visible');
});

test('enforces package allowlist, sensitive patterns, and explicit approval', () => {
  const config = { ...defaultConfig(), allowedPackages: ['com.example.*'] };
  const policy = new Policy(config);
  assert.doesNotThrow(() => policy.assertPackageAllowed('com.example.app'));
  assert.throws(() => policy.assertPackageAllowed('com.other.app'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.PackageNotAllowed);
  assert.throws(() => policy.assertPackageAllowed('com.android.settings'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.SensitivePackage);
  assert.throws(() => policy.assertApproval(false, 'app_install'), (error: unknown) => error instanceof AppError && error.code === ErrorCode.ApprovalRequired);
});

test('rejects unsafe selector regexes and deeply nested relationships', () => {
  assert.throws(() => validateSelector({ text: '(a+)+', textMode: 'regex' }));
  let selector = { text: 'leaf' };
  for (let index = 0; index < 6; index += 1) selector = { text: 'parent', descendant: selector } as typeof selector;
  assert.throws(() => validateSelector(selector));
});
