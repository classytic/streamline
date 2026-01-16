import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'integrations/fastify': 'src/integrations/fastify.ts',
    'telemetry/index': 'src/telemetry/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['mongoose', 'fastify', '@classytic/mongokit', '@opentelemetry/api'],
  treeshake: true,
  minify: false,
});
