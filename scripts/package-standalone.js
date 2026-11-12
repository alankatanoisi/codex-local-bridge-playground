#!/usr/bin/env node
'use strict';
// npm packs only the package.json allowlist. No credential files, session
// history, node_modules, or experiment artifacts belong in this archive.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const output = execFileSync(
  'npm',
  ['pack', '--ignore-scripts', '--json', '--pack-destination', path.join(root, 'dist')],
  { cwd: root, encoding: 'utf8' },
);
const packed = JSON.parse(output)[0];
console.log(
  JSON.stringify(
    { archive: path.join(root, 'dist', packed.filename), files: packed.files.length, integrity: packed.integrity },
    null,
    2,
  ),
);
