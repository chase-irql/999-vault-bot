# 0006 — Prefix commands only; the slash surface is removed

- **Status:** accepted
- **Date:** 2026-08-08
- **Supersedes:** the dual-surface requirement in the original build brief

## Context

The original brief made slash commands non-negotiable, and gave a specific reason:

> Because Message Content is privileged — it must be enabled manually in the Discord Developer
> Portal, and an unverified bot is capped at 100 guilds — **also** register slash-command
> equivalents for every command. Slash commands are not optional polish; they are the surface that
> keeps the bot functional if the intent is off or revoked.

The maintainer has decided against it: this is a prefix-driven bot for a handful of private servers,
and `jw!` is the interaction model the members already expect.

## Decision

Remove the slash surface entirely. `jw!` prefix commands are the only surface.

Removed:

- `src/bot/slash.js` — registry-to-application-command JSON.
- `contextFromInteraction` and `restFromOptions` in `src/bot/context.js`.
- The `InteractionCreate` handler and global command registration in `src/bot/client.js`.
- The `options` field on every command. It existed solely to generate slash JSON; prefix parsing
  goes through `bot/router.js` and never read it. Leaving a dead field invites a future agent to
  wire it back up.
- `applications.commands` from the documented invite scopes.

`DISCORD_CLIENT_ID` becomes **optional**. It was required only for slash registration, and the
process never actually read it — command registration went through `client.application.commands`,
which derives the ID from the token. It is still documented, because building the invite URL needs
it, but a bot that does not need a value to run must not refuse to start without one.

## The risk this accepts, stated plainly

Message Content is a privileged intent. When it is not granted, the gateway **refuses the connection
outright** rather than delivering empty messages. With no second surface, that is now a total
outage: the bot connects in slash-only mode and has no commands at all.

The mitigation is unchanged and still in `bot/client.js` — the login failure is caught, one warning
naming the exact portal toggle is logged, and the bot reconnects without the intent rather than
crash-looping. It will simply do nothing until the toggle is turned back on.

This is acceptable at this scale because:

- the deployment is a handful of private guilds under one owner's control;
- an unverified bot under 100 guilds can enable Message Content freely, with no review;
- the toggle does not change on its own — it changes when someone changes it.

It would **not** be acceptable for a bot approaching the 100-guild verification threshold, where
Message Content requires Discord's approval and can be declined. If this bot ever grows toward that,
reinstating the slash surface is the first thing to do, and this ADR is the reason why.

## Consequences

- One command path, not two. The "a command is defined once, both surfaces route into it" property
  is now trivially true because there is only one surface.
- `CommandContext` keeps its `source` field, always `"prefix"`. It costs nothing and keeps the
  provenance explicit.
- Per-command channel restriction via Discord's **Integrations → Command Permissions** is no longer
  available — that feature only governs application commands. `CHANNEL_ALLOWLIST` and channel
  permission overwrites are now the only two ways to restrict where commands work.
- Existing installs that were invited with `applications.commands` are unaffected; the scope simply
  goes unused. No re-invite is needed.
