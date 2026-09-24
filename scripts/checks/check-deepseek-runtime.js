#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadProjectEnvironment } = require('../shared/load-env');

loadProjectEnvironment();
const result = spawnSync(process.execPath, [
  '--import', 'tsx', path.join(__dirname, 'check-model-availability.ts'),
], { stdio: 'inherit', env: process.env });
if (result.error) console.error('Unable to start model access check.');
process.exitCode = result.status ?? 1;
