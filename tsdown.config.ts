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
    // Scope patterns as REGEX (a bare string matches only the EXACT specifier and misses
    // every subpath — falsified in ../mongokit/tsdown.config.ts). `@spinekit/` added
    // because a scope that stops matching after a rename still reports success; see
    // commerce/AGENTS.md §"eight things that are NOT a source grep".
    neverBundle: [/^@classytic\//, /^@spinekit\//, /^mongoose(\/|$)/, /^luxon(\/|$)/, /^semver(\/|$)/],
  },
  publint: 'ci-only',
  // ESM-only package: tell attw so it doesn't flag the intended
  // CJS-resolves-to-ESM / no-node10-resolution behavior as problems (matches
  // the sibling @classytic packages' esm-only profile).
  attw: { profile: 'esm-only' },
});
