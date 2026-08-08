# Architecture

## What this service is

One Node.js process. It holds a single gateway connection to Discord, a single HTTP client to the
JuiceWRLDAPI archive, and at most one voice connection per guild. It is designed for up to five
private guilds and under fifty concurrent listeners. It stores nothing on disk.

## The three boundaries that matter

Most of the design follows from three decisions. Everything else is detail.

### 1. `CommandContext` separates commands from Discord

A command never sees a `Message`. It sees a `CommandContext`:

```js
{
  source: "prefix",
  guildId, channelId, userId, userTag,
  memberVoiceChannelId,          // string | null
  getMemberVoiceChannel(),       // opaque handle passed to the audio layer
  args,                          // string[], quote-aware tokens
  rest,                          // raw remainder after the command name
  reply(payload), editReply(payload), defer(),
  deps                           // injected services
}
```

`bot/context.js` builds it from a `messageCreate` event. Commands import nothing from `discord.js`,
so the whole command layer is decoupled from the gateway rather than merely tidy about it.

This boundary originally existed to let one implementation serve both a prefix and a slash surface.
The slash surface was removed in [ADR 0006](decisions/0006-prefix-only.md), and the boundary earned
its keep anyway — the payoff that remains is testing. A fake context records reply payloads into an
array, so a command runs against a mocked `ArchiveApi` and a fake player and is asserted on with no
gateway, no voice connection, and no network. `source` is kept, and is always `"prefix"`.

`jw!` is now the only way in, which makes Message Content a single point of failure. That trade is
argued in the ADR.

### 2. `GuildPlayer` is the single state authority

Everything mutable about a guild — voice connection, queue, current track, loop mode, volume, radio
mode — lives in one `GuildPlayer`. Commands call intent methods and render what comes back. They do
not reach into the queue array, do not touch a `VoiceConnection`, and do not build an
`AudioResource`.

`audio/registry.js` is the only module that constructs or destroys a `GuildPlayer`. This is what
makes multi-guild isolation a property of the design rather than something to hope for: there is no
shared mutable playback state to leak across guilds, and destroying guild A's player is by
construction unable to touch guild B's.

The two things that *are* shared — the `ArchiveApi` (with its cache and its global rate gate) and
the `RadioStation` poller — are shared deliberately, are read-only from a guild's perspective, and
are keyed so that no guild can observe another's requests.

### 3. Purity is load-bearing, not stylistic

`core/queue.js`, `api/search.js`, `api/normalize.js`, `bot/embeds.js`, and `bot/router.js` are pure:
no I/O, no timers, no ambient randomness, no `discord.js`.

This is not tidiness. Song resolution quality *is* the product, and the only way to iterate on
scoring with confidence is to run it against captured fixtures thousands of times a second with no
network. Likewise, a shuffle that takes an injected RNG can be asserted exactly; one that calls
`Math.random` can only be eyeballed.

`test/boundaries.test.mjs` parses import statements and fails the build when any of these rules is
broken, because an architectural rule that is only written down is a rule that erodes.

## Data flow

```
 Discord gateway
      │
      └── messageCreate ──► bot/router.js (pure parse) ──► bot/context.js ─► CommandContext
                                                              │
                                                              ▼
                                                     bot/commands/<name>.js
                                                              │
                                    ┌─────────────────────────┼──────────────────────┐
                                    ▼                         ▼                      ▼
                             api/resolve.js            audio/registry.js       (nothing else)
                          (client → normalize          → GuildPlayer
                           → cache → search)              → audio/source.js → FFmpeg → voice
                                    │                         │
                                    └──────────► state ◄──────┘
                                                    │
                                                    ▼
                                             bot/embeds.js (pure)
                                                    │
                                                    ▼
                                               ctx.reply()
```

One direction. Nothing flows backward. An embed never fetches; a command never streams; the API
layer never knows Discord exists.

## Song resolution

Free-form text in, exactly one track or an honest disambiguation out.

1. A bare integer is tried as an `id`/`public_id` against `/songs/{id}/`.
2. A string containing `/` and ending in an audio extension is treated as an archive path.
3. Otherwise `/songs/?searchall=<query>&page_size=25&file_names_array=true`.
4. Records with no `path`, or a non-audio extension, are dropped **before** scoring — the archive
   has roughly a third of records with no playable file, and offering one is a worse failure than
   offering nothing.
5. `api/search.js` scores the survivors as a pure function (exact title 1000, exact alias 950,
   exact file name 900, prefix 700/650, all-tokens 500/450/300, substring 200), with deterministic
   tie-breakers: category preference, then era play count, then shorter title, then lower id.
6. Top score ≥ 900, or ahead of the runner-up by ≥ 200 ⇒ play it.
7. Otherwise a numbered top-5 disambiguation, resolvable for 60 seconds by a bare `1`–`5` from the
   invoking user in the same channel, or by `jw!play <id>`.

Pending disambiguations are keyed by `guildId:channelId:userId`, so two users prompting in the same
channel cannot answer each other's question — a real failure mode, and one that is tested.

## Failure posture

The bot recovers rather than dying. Every case below has defined, tested behaviour:

| Failure | Behaviour |
|---|---|
| Invoker not in voice | `UserError`, no join attempt |
| Missing `Connect`/`Speak` | Name the missing permission and the channel |
| Archive 5xx / timeout | 4 attempts, exponential backoff honouring `Retry-After`, then skip and report once |
| FFmpeg exits non-zero | stderr at debug, skip the track, report once |
| `VoiceConnectionStatus.Disconnected` | `entersState(Signalling\|Connecting, 5000)`; on failure destroy and clear |
| Alone in channel | Leave after `IDLE_DISCONNECT_MS`, clear queue, log |
| Dragged to another channel | Follow it, keep playing |
| Two `play` commands racing | Serialized by a per-guild async lock: one join, deterministic order |
| Station stream drops | Reconnect 2s/4s/8s/16s/30s, max 5 attempts, then one message |

An unhandled rejection is logged loudly but does **not** take the process down — dropping every
guild's audio because one archive promise lost its handler is worse than the bug it reports. An
uncaught exception does shut down, cleanly, non-zero.

## Deliberate non-goals

No lyrics output, no downloads or zip jobs, no account service, no persistence, no radio voting, no
unverified writes. These are listed with reasons in `CLAUDE.md` so a future agent does not add them
back as a favour.
