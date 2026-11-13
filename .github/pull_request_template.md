<!--
Title: conventional commit in plain language, e.g. "fix(engine): failed posts retry per server".
One request, one PR. Tooling, refactors and unrequested UI changes get their own PR.
-->

## Problem

<!-- A sentence or two. Link the issue, thread or failing run. -->

## Change

<!-- How this fixes it, using GLOSSARY.md words. Show the smallest picture that
makes it clear: a call tree, a before/after snippet or a file tree. -->

## Proof

<!-- What you ran and what you saw for the changed behaviour. "bun run check passes" alone is not proof.
- Logic bug: the test that fails without the fix and passes with it.
- Card or embed: before/after PNGs from `bun run admin report-mock --game <game> --out <file>` (or `report-match` for a real match).
- Adapters, enrichment, delivery or polling: the `bun run test:live` result or the live gate run.
- Workflows: PR runs use master's copy of live-gate.yml, so say how the change gets checked after merge. -->

**Not verified:** <!-- what you could not check and why. Write "nothing" only when that's true. -->

## Merge danger

**Door:** <!-- two-way (a revert undoes it) or one-way (migration, deleted data, public log, external setting) -->

**Blast radius:** <!-- e.g. dev only, CI only, one game's reports, every server's reports -->

<!-- End with the model and harness that did the work. -->
