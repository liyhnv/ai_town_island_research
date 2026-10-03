# Stage 0 — Diagnosing the Baseline: Motivation Never Enters the Decision

**Codebase:** [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town), unmodified fork.
**Files:** `patches/00-baseline/agent.ts`, `patches/00-baseline/agentOperations.ts`

## The scenario

To study emergent social behavior under resource scarcity, I set up an "island survival"
variant of AI Town: 6 characters (Lucky, Kurt, Stella, Alice, Bob, Pete) are stranded after a
shipwreck with limited food, each given a persona (`identity`) and a private `plan` describing
their stance on sharing resources (e.g. a family wanting to hoard vs. an agent wanting to pool
food for the group).

## What I found reading the engine

AI Town's agent loop (`Agent.tick()` in `agent.ts`, driven by `agentDoSomething` in
`agentOperations.ts`) decides who an agent talks to in two branches:

- **Already pathfinding (`player.pathfinding === true`):** call `findConversationCandidate`,
  which — in the original code — is a pure `internalQuery` that sorts nearby, cooldown-eligible
  players **by distance only**.
- **Standing still (`!player.pathfinding`):** either run a canned "activity" or call
  `wanderDestination(map)`, which is `Math.random()` over the whole map — no player state is
  consulted at all.

In both branches, `identity` and `plan` — the only place each agent's stance on sharing is
recorded — are **never read** when deciding *who to approach*. They are only used later, inside
the LLM prompt for *what to say* once a conversation has already started (`conversation.ts`).

## Why this matters for the research question

If I want to study whether cooperative or hoarding norms emerge from repeated interaction, the
selection of *who talks to whom* is a core causal variable: it determines whether a "pro-sharing"
agent and a "hoarding" agent are even likely to meet, or whether topic-relevant conversations can
chain into visible shifts in group-level belief. A distance+cooldown-only selector makes
conversation partners effectively random with respect to motivation, which would wash out any
emergent structure before it has a chance to appear.

This is the gap that motivated Stage 1.

## A methodological note

`data/00-baseline/baseline_records.xlsx` and `data/01-fixed-motivation/solution1_records.xlsx`
are not two independent runs — I confirmed (by matching `worldId` and overlapping
`conversationId`s in the raw Convex export) that both are time-slices of the **same continuously
running world** (created 2026-09-06, messages spanning 09-06 through 09-08): the baseline behavior
is simply what that world looked like before Solution 1's code was deployed, and the Solution-1
behavior is the same world's later conversations, after a live code deploy. Agents' accumulated
memories carry across that boundary — this is a before/after comparison within one run, not a
clean A/B test with two freshly-seeded worlds. Worth stating explicitly rather than implying
otherwise.
