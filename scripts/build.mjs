import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rspack } from '@rspack/core';
import { ExternalsLoadingPlugin as PatchedPlugin } from '@lynx-js/externals-loading-webpack-plugin';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const modes = ['sync', 'callback', 'async', 'sync-no-concat', 'startup-preload'];
export const runtimeURL = 'https://example.test/react.lynx.bundle';
export const layer = 'react:background';
const { ExternalsLoadingPlugin: UpstreamPlugin } = await import('../.generated/upstream-loader.mjs');

export function generateFixture() {
  fs.mkdirSync(path.join(root, '.generated'), { recursive: true });
  for (let i = 0; i < 100; i++) {
    fs.writeFileSync(path.join(root, `.generated/module-${i}.mjs`),
      `import { create } from 'react-runtime';\nexport const item${i} = create(${i});\n`);
  }
  const imports = Array.from({ length: 100 }, (_, i) => `import { item${i} } from './module-${i}.mjs';`).join('\n');
  const items = Array.from({ length: 100 }, (_, i) => `item${i}`).join(',');
  fs.writeFileSync(path.join(root, '.generated/entry.mjs'),
    `${imports}\nglobalThis.events.push('business');\nglobalThis.results = [${items}];\n`);
}

export async function build(mode) {
  const preload = mode === 'startup-preload';
  const Plugin = preload ? PatchedPlugin : UpstreamPlugin;
  const asyncOption = mode.startsWith('sync') ? false : mode === 'async' ? true
    : ({ systemInfo }) => ['Harmony', 'web'].includes(String(systemInfo.platform));
  const compiler = rspack({
    context: root,
    mode: 'production',
    target: 'node18',
    entry: { main: { import: './.generated/entry.mjs', layer } },
    output: { path: path.join(root, 'dist', mode), filename: 'bundle.js' },
    optimization: { concatenateModules: mode !== 'sync-no-concat' },
    devtool: false,
    plugins: [new Plugin({
      backgroundLayer: layer,
      mainThreadLayer: 'react:main-thread',
      externals: {
        'react-runtime': {
          url: runtimeURL,
          libraryName: ['ReactLynx', 'React'],
          async: asyncOption,
          ...(preload ? { startupPreload: true } : {}),
          background: { sectionPath: 'ReactLynx' },
          mainThread: { sectionPath: 'ReactLynx__main-thread' },
        },
      },
    })],
  });
  const stats = await new Promise((resolve, reject) => {
    compiler.run((error, value) => error ? reject(error) : resolve(value));
  });
  await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  const json = stats.toJson({ all: false, modules: true, nestedModules: true, optimizationBailout: true, assets: true });
  fs.writeFileSync(path.join(root, 'dist', mode, 'stats.json'), JSON.stringify(json, null, 2));
  return { code: fs.readFileSync(path.join(root, 'dist', mode, 'bundle.js'), 'utf8'), stats: json };
}
