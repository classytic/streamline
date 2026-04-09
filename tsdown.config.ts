import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/integrations/fastify.ts',
    'src/telemetry/index.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  deps: {
    neverBundle: ['mongoose', '@classytic/mongokit', 'luxon', 'semver'],
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
