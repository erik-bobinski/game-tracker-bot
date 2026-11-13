# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `13909c9` (2026-10-13), copied from `src/`
- Installed: generic plugin `index.ts`, Effect plugin `effect/index.ts`
- Deviations: `*.test.ts` files not copied. No source changes.

The files are excluded from `tsconfig.json`, prettier and oxlint so they stay
identical to upstream. To update, diff a newer upstream `src/` against this
commit and port the changes.
