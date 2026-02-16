# MDI Autonomous Systems (Runtime-Consistent)

Last updated: 2026-02-16

This file documents actual wiring and current operational caveats.

## Summary

MDI has autonomous modules for purge drama, chaos events, intelligence generation, feeds, and related jobs. There are two execution patterns:

- API route registration happens inside `server.js` (port `3851`).
- Recurring autonomous loops are expected to run as separate worker processes.

`server.js` intentionally disables local `.start()` calls for several engines to avoid double execution.

## Purge Drama (`purge-drama.cjs`)

### APIs mounted by `server.js`
- `GET /api/purge/death-row`
- `POST /api/purge/vouch`
- `GET /api/purge/vouches/:candidate`

### Runtime caveat
- `POST /api/purge/vouch` expects `req.agent` from auth middleware.
- In current `server.js` wiring, wrapper middleware for that route is commented out.
- Result: endpoint will return `401` unless auth wrapping is reintroduced.

### Loop behavior
- If run directly (`node purge-drama.cjs`), it starts its own 6-hour loop.
- In `server.js`, purge loop startup is disabled (API-only mount).

## Chaos Engine (`chaos-engine.cjs`)

### APIs mounted by `server.js`
- `GET /api/chaos/events`
- `GET /api/chaos/active`
- `POST /api/chaos/trigger` (requires `X-Admin-Key`)

### Loop behavior
- If run directly (`node chaos-engine.cjs`), it starts its own interval loop.
- In `server.js`, chaos loop startup is disabled (API-only mount).

## Other Autonomous/Background Jobs

Observed as independent workers on host at review time:
- `mdi-feeds.cjs`
- `intelligence-loop.cjs`
- `pulse-generator.cjs`
- `scripts/dlq-retry.cjs`
- `oracle-engine-v2.cjs`
- `purge-drama.cjs`

Not all are currently represented as active PM2 processes in this host snapshot.

## Deployment Reality Check

- `ecosystem.config.cjs` defines many apps (including optional jobs with `autorestart: false`).
- Actual process state can differ from ecosystem config.
- Always verify with host process inspection before claiming a module is running.

## Operational Guidance

1. Treat `server.js` as API surface, not the sole scheduler for all autonomous behaviors.
2. Maintain one authoritative process manager configuration for workers.
3. Add startup health checks per worker and an aggregated health endpoint.
4. Add tests ensuring module routes requiring auth are wrapped correctly.
5. Keep this doc updated when startup wiring changes.
