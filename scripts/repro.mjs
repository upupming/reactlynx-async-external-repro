import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { build, generateFixture, modes, root } from './build.mjs';
import { createHost, settle } from './host.mjs';

generateFixture();
const results = [];
for (const mode of modes) {
  const { code, stats } = await build(mode);
  const host = createHost(mode.startsWith('sync') ? 'Android' : 'Harmony');
  vm.runInContext(code, host.context);
  await settle();
  if (!mode.startsWith('sync')) assert.equal(host.events.includes('business'), false);
  host.release();
  await settle();
  assert.equal(host.context.results.length, 100);
  assert.equal(host.context.results[99], 100);
  const modules = stats.modules ?? [];
  results.push({
    mode,
    bytes: Buffer.byteLength(code),
    gzipBytes: gzipSync(code, { level: 9 }).length,
    asyncBailouts: modules.filter(module => module.optimizationBailout?.includes('ModuleConcatenation bailout: Module is async')).length,
    concatenatedGroups: modules.filter(module => / \+ \d+ modules$/.test(module.name ?? '')).map(module => module.name),
    files: stats.assets.filter(asset => asset.name).map(asset => asset.name),
    events: host.events,
  });
}
const callback = results.find(result => result.mode === 'callback');
const fixed = results.find(result => result.mode === 'startup-preload');
assert(callback.asyncBailouts > 0);
assert.equal(fixed.asyncBailouts, 0);
assert(fixed.bytes < callback.bytes);
assert(fixed.concatenatedGroups.length > 0);
const report = { node: process.version, rspack: '1.7.12', loader: '0.3.0', fixtureModules: 100, results };
fs.writeFileSync(path.join(root, 'dist', 'results.json'), JSON.stringify(report, null, 2));
console.table(results.map(({ mode, bytes, gzipBytes, asyncBailouts, concatenatedGroups }) => ({ mode, bytes, gzipBytes, asyncBailouts, concatGroups: concatenatedGroups.length })));
console.log('All variants execute correctly. Results: dist/results.json');
