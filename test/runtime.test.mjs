import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { ExternalsLoadingPlugin } from '@lynx-js/externals-loading-webpack-plugin';

const url = 'https://example.test/react.template.js';
const globalKey = Symbol.for('__LYNX_EXTERNAL_GLOBAL__');

class Hook {
  callbacks = [];
  tap(name, callback) { this.callbacks.push(callback); }
}
class RuntimeModule {
  static STAGE_ATTACH = 10;
  static STAGE_TRIGGER = 20;
  constructor(name, stage) { this.stage = stage; }
}

function harness(layer, platform, options = {}) {
  const compiler = {
    options: {},
    webpack: {
      RuntimeModule,
      RuntimeGlobals: { require: '__webpack_require__', publicPath: '__webpack_require__.p', startup: '__webpack_require__.x' },
    },
    hooks: { environment: new Hook(), compilation: new Hook() },
  };
  const external = {
    url,
    libraryName: ['ReactLynx', 'React'],
    startupPreload: true,
    async: ({ systemInfo }) => ['Harmony', 'web'].includes(String(systemInfo.platform)),
    mainThread: { sectionPath: 'ReactLynx__main-thread' },
    background: { sectionPath: 'ReactLynx' },
  };
  new ExternalsLoadingPlugin({
    mainThreadLayer: 'react:main-thread', backgroundLayer: 'react:background',
    externals: {
      ordinaryFirst: { ...external, startupPreload: false, async: false, libraryName: ['ReactLynx', 'Ordinary'] },
      runtime: external,
      'runtime/internal': { ...external, libraryName: ['ReactLynx', 'Internal'] },
      unused: { ...external, startupPreload: false, libraryName: 'Unused' },
      otherLayer: { ...external, libraryName: 'OtherLayer', [layer === 'react:main-thread' ? 'mainThread' : 'background']: undefined },
    },
  }).apply(compiler);
  compiler.hooks.environment.callbacks[0]();
  const types = {};
  for (const request of ['runtime', 'unused']) {
    compiler.options.externals[0]({ request, contextInfo: { issuerLayer: layer } }, (error, value, type) => {
      types[request] = type;
    });
  }
  const runtimes = [];
  const compilation = {
    hooks: { additionalTreeRuntimeRequirements: new Hook() },
    chunkGraph: { getChunkModulesIterable: () => [{ layer }] },
    addRuntimeModule(chunk, runtime) {
      runtime.chunk = chunk;
      runtimes.push(runtime);
    },
  };
  compiler.hooks.compilation.callbacks[0](compilation);
  compilation.hooks.additionalTreeRuntimeRequirements.callbacks[0]({ name: 'page', hasRuntime: () => true }, new Set());
  const events = [];
  let release;
  const response = new Promise(resolve => {
    release = resolve;
  });
  const namespace = { React: { ready: true }, Internal: {} };
  const lynx = {
    SystemInfo: { platform },
    [globalKey]: options.cached === 'pending' ? { ReactLynx: response.then(() => namespace) } : options.cached === 'namespace' ? { ReactLynx: namespace } : {},
    fetchBundle: () => ({
      then: (resolve, reject) => response.then(resolve, reject),
      wait: () => {
        events.push('wait');
        return { code: options.code ?? 0, url };
      },
    }),
    loadScript: section => {
      events.push('load');
      assert.equal(section, layer === 'react:main-thread' ? 'ReactLynx__main-thread' : 'ReactLynx');
      if (options.scriptError) {
        throw new Error('loadScript failure');
      }
      return namespace;
    },
  };
  const context = vm.createContext({
    lynx, Promise, Symbol, console: { warn() {}, error() {} },
    __webpack_require__: { x: () => {
      assert.equal(lynx[globalKey].ReactLynx, namespace);
      events.push('business');
      return 42;
    } },
  });
  for (const runtime of runtimes.sort((a, b) => a.stage - b.stage)) {
    vm.runInContext(runtime.generate(), context);
  }
  // The real background cache-events runtime wraps the preload gate later.
  vm.runInContext('var next = __webpack_require__.x; __webpack_require__.x = () => next().finally(() => cleanup());', context);
  context.cleanup = () => events.push('cleanup');
  return {
    events, types,
    start: () => context.__webpack_require__.x(),
    readOrdinaryAlias: () => lynx[globalKey].Unused,
    namespace,
    release: () => release({ code: options.code ?? 0, url }),
  };
}

for (const layer of ['react:main-thread', 'react:background']) {
  for (const platform of ['Harmony', 'web', 'Android', 'iOS']) {
    test(`${layer} ${platform}: startup order, single section load, sync external type`, async () => {
      const h = harness(layer, platform);
      assert.equal(h.types.runtime, undefined);
      assert.equal(h.types.unused, 'promise');
      const first = h.start();
      const second = h.start();
      if (platform === 'Harmony' || platform === 'web') {
        assert.deepEqual(h.events, []);
        h.release();
      } else {
        assert.deepEqual(h.events, ['wait', 'load', 'business']);
      }
      assert.equal(await first, 42);
      assert.equal(await second, 42);
      assert.equal(h.readOrdinaryAlias(), h.namespace);
      assert.equal(h.events.filter(event => event === 'business').length, 1);
      assert.equal(h.events.filter(event => event === 'load').length, 1);
      assert.equal(h.events.at(-1), 'cleanup');
    });
  }
  for (const platform of ['Harmony', 'Android']) {
    for (const failure of ['fetch', 'script']) {
      test(`${layer} ${platform}: ${failure} failure rejects without business execution`, async () => {
        const h = harness(layer, platform, failure === 'fetch' ? { code: -2 } : { scriptError: true });
        const startup = h.start();
        h.release();
        await assert.rejects(startup);
        // Startup failure is terminal for this bundle instance; the host reloads it.
        await assert.rejects(h.start());
        assert.equal(h.events.includes('business'), false);
        assert.equal(h.events.at(-1), 'cleanup');
      });
    }
  }
  for (const cached of ['pending', 'namespace']) {
    test(`${layer}: reuse ${cached} namespace without loadScript`, async () => {
      const h = harness(layer, 'Harmony', { cached });
      const startup = h.start();
      if (cached === 'pending') {
        assert.deepEqual(h.events, []);
      }
      h.release();
      assert.equal(await startup, 42);
      assert.equal(h.events.includes('load'), false);
    });
  }
}
