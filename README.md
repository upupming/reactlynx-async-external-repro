# ReactLynx async external: bundle-size regression and startup-preload prototype

A minimal reproduction using the **published external-loading plugin**, Rspack, 100 synthetic business modules, and a mocked Lynx external-loader API. It compares the existing Promise-external strategy with an experimental startup-preload strategy.

**No business application, private packages, CDN assets, network fetches, or device are required.** This measures generated JavaScript, not an encoded Lynx `template.js`, Gecko ZIP size, rendering correctness, or device performance.

## Run

```sh
nvm use # Node 22; alternatively use your Node version manager
npm ci
npm run verify
```

`npm run repro` builds all five variants, runs their output in a VM, checks runtime-before-business ordering, and writes `dist/results.json` plus each variant's `bundle.js` and `stats.json`. `npm test` runs 20 generated-runtime regression tests.

Pinned dependencies:

- `@rspack/core@1.7.12`
- `@lynx-js/externals-loading-webpack-plugin@0.3.0`
- `patch-package@8.0.1`

The install script saves an **unmodified upstream plugin** under ignored `.generated/` before applying the tracked experimental patch. All control variants use that upstream copy; only `startup-preload` uses the patched plugin. Thus this is not a hand-written substitute for the failing plugin, and installing the patch does not change the controls.

## Measured results

macOS arm64, Node 22.23.1. Node 24.20.0 produced the same sizes. Bytes are generated `bundle.js`; gzip uses zlib level 9.

| Variant | JS bytes | gzip bytes | `Module is async` bailouts | Concatenated groups |
|---|---:|---:|---:|---:|
| `async: false` | 3,712 | 1,430 | 0 | 1 |
| Platform callback | 20,921 | 3,649 | 102 | 0 |
| `async: true` | 20,465 | 3,505 | 102 | 0 |
| Sync, concatenation disabled | 9,420 | 2,743 | 0 | 0 |
| Startup-preload prototype | 4,426 | 1,712 | 0 | 1 |

All variants emit **one JS file** and produce the same 100 business results. The fixed variant is 78.84% smaller than the callback variant in this deliberately small synthetic fixture, and 714 bytes larger than the synchronous reference. **Do not extrapolate that percentage to real applications.**

The exact platform predicate is:

```js
async: ({ systemInfo }) =>
  ['Harmony', 'web'].includes(String(systemInfo.platform))
```

Even when this predicate selects synchronous loading at runtime, its external remains a Promise external at compile time. That compile-time choice affects the shared module graph, not just Harmony execution.

## Why it grows

1. The released plugin emits `promise` externals for both `async: true` and function-valued `async`.
2. Async module semantics propagate through static ESM imports to the business modules.
3. Rspack reports `ModuleConcatenation bailout: Module is async`; those modules can no longer be scope-hoisted together.
4. The emitted modules also carry async dependency/completion wrappers.

The `sync-no-concat` variant isolates the cost of losing scope hoisting. The additional difference in the async variants includes generated async wrappers/runtime. This reproduction does **not** establish an export-level tree-shaking regression.

See [scripts/build.mjs](scripts/build.mjs) for the exact compiler/plugin options and [scripts/host.mjs](scripts/host.mjs) for the mocked `fetchBundle`/`loadScript` interface. The fixture is generated at run time; it imports only a synthetic `react-runtime` external, whose namespace is supplied by the host mock.

## Proposed fix: wait at startup, keep business externals synchronous

The patch adds an **experimental opt-in** flag:

```js
{
  async: ({ systemInfo }) =>
    ['Harmony', 'web'].includes(String(systemInfo.platform)),
  startupPreload: true,
}
```

With this flag:

```text
Fetch runtime using the platform-selected loader
    -> execute the correct runtime section
    -> mount the resolved namespace
    -> execute business entry startup
```

The external references seen by the business graph remain synchronous, so business modules remain eligible for concatenation. The startup wrapper still waits asynchronously when required. Merely changing a Promise external to `var` without this startup barrier would be incorrect.

The existing behavior remains the default for ordinary externals. The patch also fixes ordering with the cache-events startup wrapper, retains section/alias deduplication, reuses pending/resolved namespace caches, and prevents repeated business startup.

Patch: [patches/@lynx-js+externals-loading-webpack-plugin+0.3.0.patch](patches/@lynx-js+externals-loading-webpack-plugin+0.3.0.patch).

### Validation boundaries

- The compiler size comparison uses the background layer. Runtime unit tests generate both main-thread and background code.
- Tests cover Harmony/web delayed startup, Android/iOS synchronous execution, mixed ordinary/preloaded aliases, single section evaluation, namespace caches, fetch/loadScript failures, and cleanup ordering.
- The tests use mocked host APIs and a simplified cache-events wrapper, not a running Lynx engine.
- No native first-screen, real event replay, CSS adoption, hydration, lazy-bundle export, page-destruction, or runtime performance validation has been done here.
- Startup failure is terminal for the current bundle instance after configured fetch retries; this prototype does not promise retrying partially initialized business code.

Treat the patch as a design experiment, **not a production-ready upstream API**.

## Files

- `scripts/save-upstream.mjs`: preserve the released plugin for controls.
- `scripts/build.mjs`: generate and compile identical synthetic business inputs.
- `scripts/repro.mjs`: size/statistics comparison and execution assertions.
- `test/runtime.test.mjs`: installed patched-plugin regression tests.
- `results.example.json`: measured example output; regenerate with `npm run repro`.
- GitHub Actions runs `npm ci && npm run verify` on Node 22.

## License

Apache-2.0. The patch modifies the Apache-2.0-licensed external-loading plugin from [lynx-family/lynx-stack](https://github.com/lynx-family/lynx-stack).
