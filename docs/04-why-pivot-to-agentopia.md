# Why I Moved Past Patching AI Town

## The pattern across three stages

Each stage in this repo fixed a real, demonstrated problem:

| Stage | Fixed | Left unfixed |
|---|---|---|
| 1 — invite scoring | Candidates are ranked by motivation, not just distance | Only reached when already pathfinding |
| 2 — wander targeting | Standing-still agents can now walk toward a relevant person | Still gated by cooldown/candidate-pool state unrelated to motivation |
| 3 — dynamic sub-goal | Motivation text reflects the last conversation, not just static backstory | Sub-goal is overwritten wholesale each time; no persistent memory of *specific commitments* to *specific people* |

The quantitative decision-log data backs this up directly: across two full runs with logging
enabled, the fraction of invite decisions that fell into `no_candidates` (wanted to decide, had
nobody eligible) was 52% and then 67% — it did not improve as the motivation-scoring logic got
more sophisticated, because `no_candidates` is produced upstream of any scoring (see
`02-fixed-motivation.md` and `analysis/decision_log_stats.py`). Motivation-driven choices stayed a
minority of all decisions throughout.

## The conclusion I draw from this

AI Town's engine treats "who to talk to" and "what you believe / have committed to" as separate
systems that I was wiring together after the fact, one call site at a time. Every stage improved
the wiring at one call site (invite, then wander, then the text being scored) without changing the
fact that the underlying state — persistent goals, commitments to specific other agents, a
sense of whether a prior request was ever followed up on — doesn't exist as first-class state in
the engine. That's a structural ceiling on patch-based fixes, not a bug I can code my way around
inside `agent.ts`.

## Where I'm looking next

This is what led me to **[Agentopia: Long-Term Life Simulation and Learning in Agent Societies](https://arxiv.org/abs/2606.07513)**
— a framework built for long-horizon (simulated-decade) multi-agent societies where agents pursue
needs/goals and build relationships over time, rather than one built for short, scripted
scenarios with motivation retrofitted on top. I have only read the abstract in depth so far
(the paper's "life reward" mechanism and 100-agent, 10-year setup is the headline result); the
next step is reading its method section closely to see exactly how it represents agent
goals/needs as explicit, persistent state and how that compares to the gaps documented above —
and to decide which parts of that design are worth adapting back into a scarcity-focused scenario
closer to the one I started with.

*(This document intentionally stops at the point of the pivot — the Agentopia-based work is a
separate, ongoing phase and will get its own write-up once there's implementation and data to
show, rather than being folded into this repo's narrative.)*
