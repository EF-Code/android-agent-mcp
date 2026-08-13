#!/usr/bin/env node

import { spawn } from 'node:child_process';

const REQUIRE_SCRCPY = process.argv.includes('--require-scrcpy');

function runVersion(executable) {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, message: `${executable} did not respond within 5 seconds.` });
    }, 5_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `${executable} is unavailable: ${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const version = `${stdout}${stderr}`.trim().split(/\r?\n/u)[0] ?? '';
      resolve(
        code === 0
          ? { ok: true, message: version }
          : {
              ok: false,
              message: `${executable} exited with code ${code ?? 'unknown'}: ${version}`,
            },
      );
    });
  });
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(`Node.js 22 or newer is required; found ${process.versions.node}.\n`);
  process.exit(1);
}

const adb = await runVersion('adb');
if (!adb.ok) {
  process.stderr.write(`${adb.message}\nInstall Android platform-tools, then rerun this check.\n`);
  process.exit(1);
}
process.stdout.write(`adb: ${adb.message}\n`);

const scrcpy = await runVersion('scrcpy');
if (scrcpy.ok) {
  process.stdout.write(`scrcpy: ${scrcpy.message}\n`);
} else if (REQUIRE_SCRCPY) {
  process.stderr.write(
    `${scrcpy.message}\nInstall scrcpy or omit --require-scrcpy for headless validation.\n`,
  );
  process.exit(1);
} else {
  process.stdout.write('scrcpy: unavailable (optional for headless tools)\n');
}

process.stdout.write(
  'Environment checks passed. The server will not install packages, change udev rules, restart ADB, or use elevated privileges.\n',
);
