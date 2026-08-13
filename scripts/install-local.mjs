#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const skipDependencies = process.argv.includes('--skip-dependencies');
const checkEnvironment = process.argv.includes('--check-environment');

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit code ${code ?? 'unknown'}`}.`));
    });
  });
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(`Node.js 22 or newer is required; found ${process.versions.node}.\n`);
  process.exit(1);
}

if (npmCli === undefined || npmCli.length === 0) {
  process.stderr.write('Run this script through npm so npm_execpath is available.\n');
  process.exit(1);
}

if (!skipDependencies) {
  await run(process.execPath, [npmCli, 'ci']);
}

if (checkEnvironment) await run(process.execPath, [join(projectRoot, 'scripts', 'check-environment.mjs')]);
await run(process.execPath, [npmCli, 'run', 'build']);

const entrypoint = join(projectRoot, 'dist', 'index.js');
process.stdout.write(`\nLocal installation is ready.\nMCP entrypoint: ${entrypoint}\nRun: node ${entrypoint}\n`);
process.stdout.write(`Codex registration: codex mcp add android-device -- node ${entrypoint}\n`);
process.stdout.write('Restart Codex after registration so the server and tools are reloaded.\n');
