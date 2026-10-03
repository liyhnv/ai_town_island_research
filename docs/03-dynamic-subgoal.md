# Stage 3 — From Static Text to Memory-Updated Motivation

**Files:** `patches/03-dynamic-subgoal/{agent.ts,agentDescription.ts,agentOperations.ts,memory.ts,schema.ts,aiTown-schema.ts}`

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

## Data status (open item)

`data/03-dynamic-subgoal/` is currently empty. The export I originally placed here turned out to
be a Solution-2 run where `currentSubGoal` was never actually populated (see the postscript in
`02-fixed-motivation.md`) — it was removed from this stage rather than left here mislabeled. The
data that belongs here is a later, shorter (~58-minute) run whose `currentSubGoal` population has
not yet been confirmed; once a `descriptions.xlsx` export from that run confirms the field is
non-empty, its decision logs / memories / messages / descriptions go here.
