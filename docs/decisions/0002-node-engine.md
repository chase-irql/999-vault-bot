# 0002 — `engines.node` is `>=22.9.0`, not `>=22.0.0`

- **Status:** accepted
- **Date:** 2026-08-07

## Context

The build brief specifies `>=22.0.0` in `engines`, and separately specifies that configuration is
loaded "from `.env` via Node's built-in `--env-file` flag" with no `dotenv` dependency.

Those two requirements are in tension in one real deployment case. `--env-file=.env` is a hard
error when the file does not exist:

```
node: .env: not found
```

A Linux host that supplies configuration through real environment variables — a systemd unit, a
container with `-e`, a PaaS dashboard — has no `.env` file, and `npm start` would fail on a
correctly configured machine. The flag that tolerates this is `--env-file-if-exists`, which landed
in **Node v22.9.0**, not v22.0.0.

## Decision

Use `--env-file-if-exists=.env` and declare `engines.node: ">=22.9.0"`.

## Alternatives rejected

- **`--env-file=.env` and require the file.** Forces an empty `.env` to exist on hosts that inject
  real environment variables. That is a footgun that presents as a startup crash.
- **Read `.env` by hand in `config.js`.** Reimplements dotenv — the exact dependency the brief
  removes — and adds a file read and a parser to the composition path.
- **Declare `>=22.0.0` anyway.** It would be a false claim. A user on Node 22.4 would install
  cleanly and then fail at `npm start` with an unhelpful flag error.

## Consequences

- The floor is nine patch releases higher than specified. Node 22.9.0 was released in September
  2024; 22.x is in maintenance and every current 22 release satisfies it.
- CI runs Node 22 and 24, both well past the floor.
- `test/deps.test.mjs` asserts the declared engine, so the tension is documented in a failing test
  rather than rediscovered.

The measured development machine runs **Node v26.3.1**.
