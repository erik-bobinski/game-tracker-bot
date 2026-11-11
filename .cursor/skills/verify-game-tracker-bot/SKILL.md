---
name: verify-game-tracker-bot
description: Bounded live reporting-pipeline verification with real account data, APIs, SQLite and dev Discord, plus desktop slash-command checks.
---

# Verify game-tracker-bot

Read [the canonical live testing guide](../../../docs/live-testing.md) before
running any live verification. It documents `bun run test:live` (also `verify`),
Infisical configuration, budgets, CI setup, desktop checks and cleanup.

Use one approved real account, one game, one match and only the dedicated test
Discord server. No production DB copy or account enumeration. Game APIs,
enrichment, SQLite, card rendering and Discord REST remain real. The command
does not start or leave a bot gateway running, and stops on throttling.

For changes visible to a user, also exercise slash commands in the desktop
Discord app as the dedicated `agent` account, only in `riot-tracker-testing`.
Record permissions/configuration which prevented any requested checks.

The old tmux harness and automatic Railway production-account discovery were
removed. Historical cloud-agent notes are troubleshooting background, not the
current verification procedure. Individual recipes under `features/` are manual
tools; do not loop them over production accounts or start a second dev bot.
