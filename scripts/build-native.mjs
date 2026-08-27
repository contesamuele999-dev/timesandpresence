import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

await build({
  absWorkingDir:root,
  entryPoints:[resolve(root, 'native-entry.js')],
  outfile:resolve(root, 'native.js'),
  bundle:true,
  format:'iife',
  platform:'browser',
  target:'es2020',
});

