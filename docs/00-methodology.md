# A Note on Methodology — How This Code Was Written

This project was a 4-week summer research internship at the National Center for Applied
Mathematics, SUSTech. My advisor's explicit guidance going in was to spend the limited time on
**research design and interpretation, not on hand-writing TypeScript from scratch** — so most of
the implementation here was produced through AI-assisted ("vibe coding") development, with me
directing it rather than typing every line myself.

Concretely, across the four stages in this repo, my own work was:

- Reading the AI Town codebase closely enough to **diagnose the actual problem** (Stage 0: finding
  that `findConversationCandidate` and `wanderDestination` never read `identity`/`plan` at all —
  see [`01-baseline-problem.md`](01-baseline-problem.md)).
- Designing each patch — what to change, where, and why it should fix the diagnosed gap (the
  weighting scheme in Solution 1, extending it to the wander branch in Solution 2, the
  `currentSubGoal` mechanism in Stage 3).
- Specifying the decision-logging system so every choice would be auditable rather than something
  I'd have to infer from watching agents move around.
- Deploying each change, running the simulation, and reading the resulting data — this is where
  most of the actual findings came from (e.g. the `no_candidates` bottleneck in
  [`02-fixed-motivation.md`](02-fixed-motivation.md), the deployment bug caught in
  [`03-dynamic-subgoal.md`](03-dynamic-subgoal.md)).
- Deciding, from that data, that incremental patching had hit a structural ceiling and that a
  different kind of framework was worth looking at instead —
  [`04-why-pivot-to-agentopia.md`](04-why-pivot-to-agentopia.md).

The actual TypeScript in [`patches/`](../patches/) — the embedding-score formulas, the Convex
query/action/mutation wiring, the schema changes — was written with AI assistance under my
direction, then reviewed and tested by me against the behavior I was actually trying to produce.
I'm noting this explicitly rather than leaving it implicit, since it's a fair question for anyone
reading this repo to ask, and because I think what's actually being evaluated here — can I
diagnose a problem in an unfamiliar codebase, design a reasonable fix, instrument it so the result
is falsifiable, and correctly interpret what the data does and doesn't show — doesn't change
depending on who typed the code.
