# Stage 1–2 — Patching in a "Fixed" Motivation Score

**Files:**
`patches/01-fixed-motivation-invite/{agent.ts,agentOperations.ts}` (Solution 1),
`patches/02-fixed-motivation-wander/{agent.ts,agentOperations.ts,schema.ts}` (Solution 2 — `schema.ts`
is the project-root schema, extended here with the new `agentDecisionLogs` table). `agentDescription.ts`,
`memory.ts`, and `convex/aiTown/schema.ts` are **not** listed for either stage — diffing them against
upstream confirmed they were still byte-for-byte pristine at this point (see
[`patches/00-baseline/`](../patches/00-baseline/) and the real changes to them in Stage 3 instead).

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

### Solution 1 decision logic — `findConversationCandidate` (invite)

```
Agent idle, about to decide who to invite
        |
        v
loadCandidateContext (internalQuery)
  - apply PLAYER_CONVERSATION_COOLDOWN filter
  - load my identity+plan, each candidate's identity+plan (or playerDescription)
        |
        v
  candidates list empty?  -------------------------------> YES --> branch: no_candidates
        | NO
        v
  my own plan text missing? ----------------------------->  YES --> branch: no_plan_text
        | NO
        v
  roll RANDOM_EXPLORATION_PROBABILITY (30%)
        |                                   \
        | NO (70%)                           YES (30%)
        v                                     v
  findConversationCandidate (internalAction)   branch: random_exploration
  - embed my plan + every candidate's            (pick uniformly at random)
    motivation text via embeddingsCache
  - score each candidate:
      finalScore = MOTIVATION_WEIGHT * motivationScore
                   - DISTANCE_WEIGHT * normalizedDistance
  - pick the highest finalScore
        |
        v
  branch: motivation  (log all candidates' raw scores to agentDecisionLogs either way)
```

| Branch | Trigger | What gets logged |
|---|---|---|
| `motivation` | Embedding scoring ran and picked a winner | every candidate's `motivationScore`, `distance`, `finalScore`; the winner |
| `random_exploration` | 30% exploration roll was hit | all candidates still logged, `motivationScore: 0` (did not take part in scoring) |
| `no_candidates` | Zero candidates survived the cooldown filter | empty candidate list |
| `no_plan_text` | My own `plan` text couldn't be found (fallback case) | empty candidate list |

## Solution 2 — carrying motivation into the "wander" branch

The deeper issue Solution 1 left open: whether an agent even *looks* at candidates at all is
gated by `player.pathfinding`, a pure movement-state flag unrelated to candidate quality. An
agent that has just stopped moving skips candidate scoring entirely and calls
`wanderDestination()`, which is uniform random, no player state read.

Solution 2 adds `chooseWanderTarget`, which reuses `loadCandidateContext` (with a new
`applyCooldown: false` flag, cooldown should block *inviting* someone you just talked to, not
*walking toward* them) and the same embedding infrastructure, but drops the distance penalty
entirely: the goal here is "who should I proactively approach", so distance is expressed instead
as a ±4-tile jitter around the target's position once chosen, rather than as a scoring term. A
`WANDER_TARGET_PROBABILITY = 0.6` gate and a `WANDER_MIN_MOTIVATION_SCORE = 0.15` floor preserve
some undirected wandering.

### Solution 2 decision logic — `chooseWanderTarget` (wander)

```
Agent just stopped moving, about to wander
        |
        v
  roll WANDER_TARGET_PROBABILITY (60%)
        |                                \
        | NO (40%)                        YES (60%)
        v                                  v
  branch: random_exploration        loadCandidateContext(applyCooldown: false)
  (uniform random wander target)    - NO cooldown filter here (cooldown should block
                                       "inviting", not "walking toward")
        |                                  |
        |                                  v
        |                            candidates list empty? --> YES --> branch: no_candidates
        |                                  | NO
        |                                  v
        |                            my own plan text missing? --> YES --> branch: no_plan_text
        |                                  | NO
        |                                  v
        |                            score each candidate by motivationScore only
        |                            (no distance term — distance is expressed later
        |                             as a +/-4 tile jitter around the chosen target)
        |                                  |
        |                                  v
        |                            top motivationScore >= WANDER_MIN_MOTIVATION_SCORE (0.15)?
        |                                  |                        \
        |                                  | NO                      YES
        |                                  v                          v
        |                     branch: below_threshold           branch: motivation
        |                     (falls back to random wander,      (walk toward the winner,
        |                      but all candidate scores           +/-4 tile jitter applied)
        |                      still logged)
        v                                  |
   (both paths converge on a wander target, logged either way)
```

| Branch | Trigger | What gets logged |
|---|---|---|
| `motivation` | A candidate scored at or above `WANDER_MIN_MOTIVATION_SCORE` | every candidate's `motivationScore`; the winner; the jittered destination |
| `random_exploration` | The 40% non-purposeful roll was hit | no candidate scoring attempted |
| `below_threshold` | Best candidate score was still under 0.15 | all candidate scores logged, falls back to random wander |
| `no_candidates` | Zero candidates after (cooldown-free) filtering | empty candidate list |
| `no_plan_text` | My own `plan` text couldn't be found (fallback case) | empty candidate list |

Both decision types write to the same `agentDecisionLogs` table — see
[`patches/02-fixed-motivation-wander/schema.ts`](../patches/02-fixed-motivation-wander/schema.ts) —
so the branch distribution is directly queryable rather than inferred from movement.

## Making the decisions auditable

Both branches now write a row to a new `agentDecisionLogs` table (see
`patches/02-fixed-motivation-wander/schema.ts`) recording every candidate considered, their raw
motivation/distance/final scores, which branch fired (`motivation` / `random_exploration` /
`no_candidates` / `no_plan_text` / `below_threshold`), and who was chosen. This was essential:
without it, "the agent walked toward X" is unfalsifiable — I can't tell a motivation-driven choice
from a random one just by watching movement.

## What the logs showed

Across two full-length runs with decision logging enabled, the `no_candidates` branch (agent
wanted to decide but had zero eligible candidates after the cooldown filter) dominated the
`invite` decision type: 52% in the Solution-2 run, rising to 67% in the later Stage 3 run (see
[`03-dynamic-subgoal.md`](03-dynamic-subgoal.md)), while motivation-driven choices (`motivation`
branch, invite + wander combined) stayed a minority (28.7%, then 19.5%). The Solution-2 decision
logs are in `data/02-fixed-motivation-wander/decisionlog-export/`; see
`analysis/decision_log_stats.py` for the script used to compute these figures.

This told me the embedding-based scoring, however it was weighted, was only ever operating on the
minority of decisions that reached it: the bottleneck was upstream, in how rarely a motivation
check was even triggered.
