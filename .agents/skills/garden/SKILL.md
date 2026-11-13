---
name: garden
description: Turn agent mistakes into lasting guardrails and weed the repo. Use after a PR needed repeated review rounds or a revert, when the user corrects the same thing twice, or for a scheduled gardening pass.
---

# Garden game-tracker-bot

A correction made only in chat is lost: the next session repeats it. Gardening
moves each lesson into the repo, at the strongest layer that will hold it.

## Steps

1. **Collect evidence.** For a thread or PR: read the user's corrections, review
   findings, reverts and failed CI runs. For a scheduled pass: `bun run check`,
   `git log` since the last pass, open PRs and the last week's CI failures.
   Done when every problem has a link (thread, PR comment, run or commit).

2. **Place each problem on the ladder.** Take the first rung that can hold it:
   1. **Shape**: types, `Schema`, module boundaries or data layout that make the
      bad state impossible to write.
   2. **Check**: an oxlint rule (local rules live beside `tools/oxlint/anti-slop`),
      a test in the module's existing test file, knip config, or a CI step.
   3. **Words**: a `GLOSSARY.md` term, a "Ways to hurt this repo" line in
      `AGENTS.md`, or a skill. Words are for judgement calls; a mechanical
      pattern always gets a check.
   4. **Review**: only when nothing above can hold it.

   Done when every problem has a rung and a one-line reason.

3. **Weed.** Look for what agents will copy next:
   - dead code (`bun run knip`) and stale fallbacks nobody runs;
   - docs that name a path, script, secret or workflow step that no longer exists,
     or describe behaviour the code contradicts;
   - the same fact written in two places (keep one, point to it);
   - merged branches and stale remote branches.

4. **Ship small.** One finding per PR, using the PR template, never folded into a
   feature PR. A rule change and the fixes it forces go in the same PR. Ask before
   touching repo settings, branch protection, secrets or branches others use.

5. **Report.** A table of finding → evidence → rung → PR (or why not). Done when
   every finding from step 2 has a PR or an explicit reason it has none.
