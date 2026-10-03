# Stage 1–2 — Patching in a "Fixed" Motivation Score

**Files:**
`patches/01-fixed-motivation-invite/{agent.ts,agentOperations.ts}` (Solution 1),
`patches/02-fixed-motivation-wander/{agent.ts,agentDescription.ts,agentOperations.ts,memory.ts,aiTown-schema.ts}` (Solution 2)

"Fixed" here means the *source text* each agent is scored against — `identity` + `plan` — is set
once at world creation and never changes during the run. What's computed per-decision is an
embedding similarity ("motivation score") between that static text and each candidate's static
text; the number is recomputed every time, but the inputs to it don't move.

## Solution 1 — scoring candidates at invite time

`findConversationCandidate` was split into:
- `loadCandidateContext` (`internalQuery`): keeps the original cooldown filter, additionally loads
  `myPlanText` and, for each candidate, a `motivationText` built from their `identity` + `plan`.
- `findConversationCandidate` (promoted to `internalAction`, since embeddings require a network
  call Convex queries cannot make): batches `identity+plan` texts through the existing
  `embeddingsCache`, computes cosine similarity per candidate, and ranks by

  ```
  finalScore = MOTIVATION_WEIGHT * motivationScore − DISTANCE_WEIGHT * normalizedDistance
  ```

  with a 30% `random_exploration` branch kept so the simulation doesn't collapse into
  always-pick-the-top-match determinism.

This only affects agents who are **already pathfinding** — it does nothing for an agent standing
still deciding whether to wander.

## Solution 2 — carrying motivation into the "wander" branch

The deeper issue Solution 1 left open: whether an agent even *looks* at candidates at all is
gated by `player.pathfinding`, a pure movement-state flag unrelated to candidate quality. An
agent that has just stopped moving skips candidate scoring entirely and calls
`wanderDestination()` — uniform random, no player state read.

Solution 2 adds `chooseWanderTarget`, which reuses `loadCandidateContext` (with a new
`applyCooldown: false` flag — cooldown should block *inviting* someone you just talked to, not
*walking toward* them) and the same embedding infrastructure, but drops the distance penalty
entirely: the goal here is "who should I proactively approach", so distance is expressed instead
as a ±4-tile jitter around the target's position once chosen, rather than as a scoring term. A
`WANDER_TARGET_PROBABILITY = 0.6` gate and a `WANDER_MIN_MOTIVATION_SCORE = 0.15` floor preserve
some undirected wandering.

## Making the decisions auditable

Both branches now write a row to a new `agentDecisionLogs` table (see
`patches/03-dynamic-subgoal/schema.ts`) recording every candidate considered, their raw
motivation/distance/final scores, which branch fired (`motivation` / `random_exploration` /
`no_candidates` / `no_plan_text` / `below_threshold`), and who was chosen. This was essential:
without it, "the agent walked toward X" is unfalsifiable — I can't tell a motivation-driven choice
from a random one just by watching movement.

## What the logs showed

Across two full-length runs with decision logging enabled, the `no_candidates` branch (agent
wanted to decide but had zero eligible candidates after the cooldown filter) dominated the
`invite` decision type — 52% in the first run, 67% in a second, shorter run — while
motivation-driven choices (`motivation` branch, invite + wander combined) stayed a minority
(~20–30%). See `data/01-fixed-motivation/` and `data/02-fixed-motivation-wander/` for the raw
exports and `analysis/decision_log_stats.py` for the script used to compute this.

This told me the embedding-based scoring, however it was weighted, was only ever operating on the
minority of decisions that reached it — the bottleneck was upstream, in how rarely a motivation
check was even triggered.
