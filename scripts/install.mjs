#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = process.argv.slice(2);
const skipDependencies = args.includes('--skip-dependencies');
const checkEnvironment = args.includes('--check-environment');
const checkArgs = args.filter((argument) => argument === '--require-scrcpy');
const setupArgs = args.filter(
  (argument) =>
    argument !== '--skip-dependencies' &&
    argument !== '--check-environment' &&
    argument !== '--require-scrcpy',
);

function run(command, commandArgs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${commandArgs.join(' ')} failed with ${signal ?? `exit code ${code ?? 'unknown'}`}.`,
        ),
      );
    });
  });
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(`Node.js 22 or newer is required; found ${process.versions.node}.\n`);
  process.exit(1);
}

if (!skipDependencies) await run(npmCommand, ['ci']);
if (checkEnvironment) {
  await run(process.execPath, [
    join(projectRoot, 'scripts', 'check-environment.mjs'),
    ...checkArgs,
  ]);
}
await run(npmCommand, ['run', 'build']);
await run(process.execPath, [join(projectRoot, 'dist', 'index.js'), 'setup', ...setupArgs]);
