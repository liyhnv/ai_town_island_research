# Stage 3 — From Static Text to Memory-Updated Motivation

**Files:** `patches/03-dynamic-subgoal/{agent.ts,agentDescription.ts,memory.ts}`

`agentOperations.ts` and `schema.ts` are not listed here — they carry over unchanged from
[`patches/02-fixed-motivation-wander/`](../patches/02-fixed-motivation-wander/) (confirmed
byte-identical by diff). `convex/aiTown/schema.ts` likewise carries over unchanged from the very
start — see [`patches/_shared-unchanged/`](../patches/_shared-unchanged/).

Stage 1–2 scored agents against `identity` + `plan` — text fixed at world creation. But an
agent's real stance shifts conversation to conversation (e.g. Stella moving from "I won't share
without proof" to "I'll try rationing our own food first"). Scoring against stale text means the
motivation signal itself goes stale.

## Mechanism 2: `currentSubGoal`

A new optional field, `currentSubGoal: v.optional(v.string())`, was added to `agentDescription`.
After every conversation, `rememberConversation()` in `memory.ts` now makes one extra LLM call
(`generateSubGoal`) asking, in effect, "given how this conversation just ended, what's your
immediate sub-goal now?" — and writes the result via a new `updateCurrentSubGoal` mutation. The
motivation-scoring text used by both `findConversationCandidate` and `chooseWanderTarget` became:

```ts
myPlanText = `${identity} ${plan} ${currentSubGoal ?? ''}`.trim();
```

so the embedding comparison now reflects what an agent is *currently* trying to accomplish, not
just their static backstory.

### Mechanism 2 decision logic — what changed vs. Solutions 1 & 2

The branch structure for `findConversationCandidate` (invite) and `chooseWanderTarget` (wander)
described in [`02-fixed-motivation.md`](02-fixed-motivation.md) is **unchanged** in Stage 3 — same
branches (`motivation` / `random_exploration` / `no_candidates` / `no_plan_text` /
`below_threshold`), same cooldown rules, same `WANDER_TARGET_PROBABILITY` / `WANDER_MIN_MOTIVATION_SCORE`
gates. The only thing Stage 3 changes is **what text goes into the embedding at the very start of
both flows**:

```
Stage 1-2:  motivationText = `${identity} ${plan}`.trim()
                               ^^^^^^^^^^^^^^^^^^^^
                               fixed at world creation, never changes

Stage 3:    motivationText = `${identity} ${plan} ${currentSubGoal ?? ''}`.trim()
                                                     ^^^^^^^^^^^^^^^^^^^^^
                                                     regenerated after every conversation
                                                     by generateSubGoal() in memory.ts
```

```
End of a conversation
        |
        v
rememberConversation() (memory.ts)
  - existing: write the conversation to the memories table (unchanged)
  - NEW: call generateSubGoal() -- one extra lightweight LLM call
         "given how this conversation just ended, what's your immediate sub-goal now?"
        |
        v
  LLM call succeeded?  ------------------------> NO --> leave currentSubGoal as-is
        | YES                                          (failure doesn't block the rest
        v                                               of rememberConversation)
  updateCurrentSubGoal mutation
  - overwrites agentDescriptions.currentSubGoal for this agent (full overwrite, no merge
    with any previous sub-goal -- see "What this exposed" #1 above)
        |
        v
  Next time this agent runs findConversationCandidate / chooseWanderTarget:
  loadCandidateContext reads the NEW currentSubGoal into motivationText
  for both itself and every candidate it compares against
```

| Stage | Motivation text | Updates | Branch structure |
|---|---|---|---|
| 1–2 (fixed) | `identity + plan` | Never — fixed at world creation | `motivation` / `random_exploration` / `no_candidates` / `no_plan_text` / `below_threshold` |
| 3 (dynamic) | `identity + plan + currentSubGoal` | After every conversation, via one extra LLM call | *same five branches* — only the scoring **input** changed, not the decision tree |

That last row is the point of the "Confirmed data" section below: making the scoring *input*
smarter didn't change the *branch distribution* — `no_candidates` still dominates, and even got
worse. The bottleneck was never about the quality of the motivation text; it's about how rarely
the motivation-scoring code path is reached at all.

## What this exposed

1. **Full overwrite, no continuity.** `currentSubGoal` is replaced wholesale after each
   conversation: if Stella finishes talking to Bob and immediately starts talking to Alice, the
   sub-goal from the Bob conversation is gone before it could ever influence who she looks for
   next. There's no mechanism to *carry a specific commitment* (e.g. "I still need Bob and Pete to
   agree to share") across more than one hop.
2. **Deployment is invisible by design.** This bug class is easy to miss: for 62+ conversations in
   one run, `currentSubGoal` silently stayed empty because the code change to `memory.ts` had
   never actually redeployed. Convex gave no error, the simulation ran fine, and the only way to
   catch it was reading the live deployed file back and diffing it against what was intended.
3. **The `no_candidates` bottleneck from Stage 1–2 persists.** Making the *content* of the
   motivation text smarter doesn't change *how often* a motivation check is even reached — that's
   still gated by the same cooldown/pathfinding-state logic. See `data/03-dynamic-subgoal/` for the
   exported decision logs/memories/messages from this stage.

Each of these is independently patchable (pass the previous sub-goal into the prompt; add a
pre-cooldown-filter candidate count to disambiguate `no_candidates` causes; etc.), but each patch
addresses one symptom without touching the shared root cause: in this engine, "who to approach"
and "what you've promised" are two unrelated pieces of state that happen to be read by the same
function. See `04-why-pivot-to-agentopia.md` for how this shaped the next step.

## Confirmed data

`data/03-dynamic-subgoal/` now holds a run (`worldId m172tfkz52mxb1fg26w30w8px18fk90x`, ~58 minutes,
568 decisions logged) where `descriptions.jsonl` confirms `currentSubGoal` is populated and distinct
for all 6 agents — e.g. Kurt's reads "Commit to fair rations within our own family for a trial
period," Pete's "I need to see effort from the others before I start sharing everything." This is
the first run in this repo where Mechanism 2 is confirmed to have actually been active (contrast
with the Solution-2 run in `02-fixed-motivation.md`'s postscript, where the same field was empty
throughout).

Branch distribution for this run (`python analysis/decision_log_stats.py data/03-dynamic-subgoal/decisionlogs.jsonl`
after adding JSONL support — see note below):

| decisionType | branch | count | % |
|---|---|---|---|
| invite | no_candidates | 381 | 67.1% |
| wander | motivation | 57 | 10.0% |
| invite | motivation | 54 | 9.5% |
| wander | random_exploration | 51 | 9.0% |
| invite | random_exploration | 25 | 4.4% |

Motivation-driven share: 19.5% — lower than the 28.7% seen in the Solution-2 run, even though the
motivation text is now dynamic rather than static. This is the data point that most directly
supports `04-why-pivot-to-agentopia.md`: making the content of the motivation signal smarter
(Stage 3) did not move the needle on *how often* that signal gets consulted at all — the
`no_candidates` bottleneck identified back in Stage 1–2 is, if anything, worse here.

(Note: `decisionlogs.jsonl` here is the Convex Dashboard's raw JSONL export rather than an xlsx —
kept as-is since JSONL is already diff- and grep-friendly; `analysis/decision_log_stats.py`
currently expects xlsx and needs a small JSONL-reading branch added to run on this file directly.)
