import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/integrations/fastify.ts',
    'src/telemetry/index.ts',
  ],
  format: 'esm',
  dts: {
    sourcemap: false,
  },
  sourcemap: false,
  minify: false,
  // Externalize ALL dependencies — streamline should never bundle any package
  external: [
    'mongoose',
    'fastify',
    '@classytic/mongokit',
    '@opentelemetry/api',
    'luxon',
    'semver',
  ],
});
