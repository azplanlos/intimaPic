/**
 * Build script for the Custom ServiceWorker.
 * Uses esbuild to bundle all SW modules into a single sw.js file.
 *
 * Usage:
 *   node build-sw.mjs            (production, minified)
 *   node build-sw.mjs --dev      (development, source maps, no minify)
 */

import { build } from 'esbuild';
import { argv } from 'process';

const isDev = argv.includes('--dev');

// Allow overriding output directory via env var (used in CI)
const outputDir = process.env.SW_OUTPUT_DIR || 'dist/intimapic/browser';

await build({
  entryPoints: ['src/service-worker/sw.ts'],
  bundle: true,
  outfile: `${outputDir}/sw.js`,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: !isDev,
  sourcemap: isDev,
  define: {
    'self.__SW_VERSION__': JSON.stringify(new Date().toISOString()),
  },
  // Dexie is bundled into the SW (no external imports in SW context)
  external: [],
  logLevel: 'info',
});

console.log(`✅ ServiceWorker built successfully (${isDev ? 'development' : 'production'})`);
