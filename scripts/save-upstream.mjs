import fs from 'node:fs';

const source = fs.readFileSync(new URL(import.meta.resolve('@lynx-js/externals-loading-webpack-plugin')), 'utf8');
const backup = new URL('../.generated/upstream-loader.mjs', import.meta.url);
fs.mkdirSync(new URL('../.generated/', import.meta.url), { recursive: true });
if (!source.includes('startupPreload')) {
  fs.writeFileSync(backup, source);
} else if (!fs.existsSync(backup) || fs.readFileSync(backup, 'utf8').includes('startupPreload')) {
  throw new Error('An unpatched upstream control is required; run npm ci.');
}
