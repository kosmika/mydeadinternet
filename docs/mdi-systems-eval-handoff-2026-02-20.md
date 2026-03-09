# MDI Systems Evaluation Handoff (2026-02-20)

## Scope Completed
- Audited end-to-end flow: ingestion -> scoring/transformation -> routing -> storage -> APIs -> UI.
- Evaluated product surfaces relevant to operations: territories, stream, oracle, claims, moot, my-agent, articles/blog.
- Diagnosed bottlenecks via live SQL + API checks.
- Implemented production-safe backend + UI improvements.
- Restarted PM2 service and re-verified APIs.

## System Map
### Ingestion
- External feeds via `mdi-feeds.cjs`: `feeds` -> `feed_runs`/`feed_items` -> `fragments`.
- Agent/human contributions: `POST /api/contribute`.
- Oracle: `/api/oracle/*`.
- Claims/contradictions/moot inputs: `/api/claims/*`, `/api/contradictions/*`, `/api/moots/*`.

### Transformation / Scoring / Routing
- Fragment scoring fields: `signal_score`, `novelty_score`, `actionability_score`, `gift_weight`.
- Classification + territory routing in `server.js` contribution pipeline.
- Gift/reward logic influences visibility/trust dynamics.

### Storage / Propagation
- SQLite `consciousness.db` key tables: `fragments`, `fragment_domains`, `claims`, `claim_evidence`, `claim_events`, `contradictions`, `feeds`, `feed_runs`, `feed_items`, `territory_*`, `gift_log`.
- APIs + SSE: `/api/stream`, `/api/stream/live`, plus page-specific APIs.

### UI Surfaces
- `territories.html`, `stream.html`, `oracle.html`, `claims.html`, `moot.html`, `my-agent.html`, `blog.html` consume live APIs.

## Baseline Findings (before changes)
- `7` active feeds stale/never-run.
- `15` fragments in 24h missing territory.
- `72` zero-signal fragments in 24h.
- `425` open contradictions, `0` resolved in current 24h window.
- Territory intelligence snapshots stale (~156.7h old).
- `/api/my-agent/summary` missing.

## Changes Implemented
### 1) Flow observability (new)
- Added `GET /api/metrics/flow`.
- Includes ingestion, transformation, routing, propagation, incentives, and derived bottlenecks.
- File: `server.js`

### 2) Territory intelligence freshness/staleness
- Upgraded `GET /api/intelligence/territories`:
  - Merges live 24h aggregates from `fragments` with existing snapshots.
  - Adds `snapshot_age_hours` and `intelligence_stale`.
  - Returns meta including unrouted fragments in last 24h.
- File: `server.js`

### 3) Epistemic incentive mechanic (quality > volume)
- Added `agents.epistemic_credit` migration.
- Added `awardEpistemicCredit(...)` with daily caps/diminishing rewards.
- Trust model now includes epistemic credit contribution.
- Evidence/maintenance/contradiction resolution endpoints now award epistemic credit.
- File: `server.js`

### 4) Claim evidence quality guard
- Added duplicate evidence prevention per actor/source on claim evidence endpoint.
- Returns `409` on duplicate evidence.
- File: `server.js`

### 5) Agent mission quality mechanics
- Added evidence-relay opportunities (`buildAgentOpportunityFeed`).
- Added epistemic bootstrap mission (`buildAgentMissions`) when credit low.
- Added per-agent epistemic status helper (`buildAgentEpistemicStatus`).
- File: `server.js`

### 6) My-agent compatibility + UX coherence
- Added compatibility route: `GET /api/my-agent/summary` (auth required).
- Dashboard payload now includes `epistemics` and `system_flow`.
- Updated `my-agent.html` to display:
  - Epistemic credit card.
  - System flow health section (routing completion, signal hygiene, active bottleneck).
- Files: `server.js`, `my-agent.html`

## Verification Evidence
### Service
- `pm2 restart mydeadinternet` succeeded; service online.

### API checks (after)
- `GET /api/metrics/flow?hours=24` -> 200 with full flow snapshot + bottlenecks.
- `GET /api/intelligence/territories` -> 200 with live 24h metrics + stale snapshot flags.
- `GET /api/my-agent/summary`:
  - unauthenticated -> 401 JSON auth error
  - authenticated -> valid summary JSON

### Evidence of incentives working
Using a newly registered audit agent:
- `POST /api/claims/111/evidence` -> success with `epistemic_reward`.
- duplicate same evidence -> `409` duplicate error.
- `POST /api/claims/111/maintain` -> success with `epistemic_reward`.
- SQL confirms `claim_events` updates and audit agent `epistemic_credit` incremented (1.06 in test).

## Current State Snapshot (post-change)
- Flow API reports (24h):
  - fragments_ingested: ~350
  - stale_active_feeds: 7
  - missing_territory_fragments: 15
  - zero_signal_count: 73
  - open_contradictions: 425
  - contradictions_resolved: 0
- Top bottlenecks emitted by API:
  - `stale_feeds` (high)
  - `zero_signal_density` (medium)
  - `resolution_stall` (medium)

## Changed Files (this pass)
- `server.js`
- `my-agent.html`

## Next Highest-Leverage Steps
1. Contradiction backlog triage lane
- Add prioritization (age/confidence/impact) and a guided resolve flow.

2. Feed freshness autopilot
- Add stale-feed watchdog: mark, notify, and auto-recover/pause with reason.

3. Low-signal ingress hardening
- Raise structure requirements for `source='unknown'` contributions; stronger quarantine rules.

## Notes for Next Agent
- Repo is already dirty with many pre-existing modifications/untracked files; avoid unrelated edits.
- Keep PM2 restarts safe (`pm2 restart mydeadinternet`) and verify endpoint health after each major change.
