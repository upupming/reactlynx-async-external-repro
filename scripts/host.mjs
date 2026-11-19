import vm from 'node:vm';
import { runtimeURL } from './build.mjs';

// Mock only the existing Lynx external-loader API. No network/device access.
export function createHost(platform = 'Harmony', responseCode = 0) {
  const events = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const namespace = { React: { create: index => index + 1 } };
  const response = { code: responseCode, url: runtimeURL };
  const lynx = {
    SystemInfo: { platform },
    fetchBundle: () => ({
      then: (resolve, reject) => pending.then(resolve, reject),
      wait: () => { events.push('wait'); return response; },
    }),
    loadScript: section => {
      if (section !== 'ReactLynx') throw new Error(`Unexpected section: ${section}`);
      events.push('runtime');
      return namespace;
    },
  };
  const context = vm.createContext({ lynx, Promise, Symbol, events, console });
  return { context, events, release: () => release(response) };
}

export const settle = () => new Promise(resolve => setImmediate(resolve));
