import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'www');
const files = [
  'index.html',
  'app.js',
  'native.js',
  'config.js',
  'manifest.webmanifest',
  'sw.js',
];

await rm(output, {recursive:true, force:true});
await mkdir(output, {recursive:true});
await Promise.all(files.map(file=> cp(resolve(root, file), resolve(output, file))));
await cp(resolve(root, 'icons'), resolve(output, 'icons'), {recursive:true});

