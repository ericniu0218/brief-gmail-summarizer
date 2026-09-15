import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('work', { recursive: true });
const entries = (await readdir('tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => 'tests/' + name);
await build({
  entryPoints: entries,
  outdir: 'work/tests',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  bundle: true,
  plugins: [
    {
      name: 'test-runtime',
      setup(build) {
        build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'runtime',
          namespace: 'test-runtime',
        }));
        build.onLoad({ filter: /.*/, namespace: 'test-runtime' }, () => ({
          contents:
            'export const env = new Proxy({}, {get: (_, key) => globalThis.__briefTestEnv[key]});',
        }));
        build.onResolve({ filter: /^next\/headers$/ }, () => ({
          path: 'headers',
          namespace: 'test-headers',
        }));
        build.onLoad({ filter: /.*/, namespace: 'test-headers' }, () => ({
          contents:
            'export const headers = async () => globalThis.__briefTestHeaders;',
        }));
        build.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: 'navigation',
          namespace: 'test-navigation',
        }));
        build.onLoad({ filter: /.*/, namespace: 'test-navigation' }, () => ({
          contents:
            'export const redirect = () => { throw new Error("Unexpected redirect"); };',
        }));
      },
    },
  ],
});
const result = spawnSync(
  process.execPath,
  [
    '--test',
    ...entries.map(
      (path) => 'work/tests/' + path.split('/').at(-1).replace('.ts', '.mjs'),
    ),
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
