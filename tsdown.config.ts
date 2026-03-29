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
  // tsdown 0.21+ auto-externalizes all deps/peerDeps from package.json.
  // No manual `external` list needed — can't miss a dep, can't bundle by accident.
});
