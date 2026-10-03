# Why I Moved Past Patching AI Town

## The pattern across three stages

Each stage in this repo fixed a real, demonstrated problem:

| Stage | Fixed | Left unfixed |
|---|---|---|
| 1. invite scoring | Candidates are ranked by motivation, not just distance | Only reached when already pathfinding |
| 2. wander targeting | Standing-still agents can now walk toward a relevant person | Still gated by cooldown/candidate-pool state unrelated to motivation |
| 3. dynamic sub-goal | Motivation text reflects the last conversation, not just static backstory | Sub-goal is overwritten wholesale each time; no persistent memory of *specific commitments* to *specific people* |

The quantitative decision-log data backs this up directly: across two full runs with logging
enabled, the fraction of invite decisions that fell into `no_candidates` (wanted to decide, had
nobody eligible) was 52% and then 67%, it did not improve as the motivation-scoring logic got
more sophisticated, because `no_candidates` is produced upstream of any scoring (see
`02-fixed-motivation.md` and `analysis/decision_log_stats.py`). Motivation-driven choices stayed a
minority of all decisions throughout.

## The conclusion I draw from this

AI Town's engine treats "who to talk to" and "what you believe / have committed to" as separate
systems that I was wiring together after the fact, one call site at a time. Every stage improved
the wiring at one call site (invite, then wander, then the text being scored) without changing the
fact that the underlying state (persistent goals, commitments to specific other agents, a
sense of whether a prior request was ever followed up on) doesn't exist as first-class state in
the engine. That's a structural ceiling on patch-based fixes, not a bug I can code my way around
inside `agent.ts`.

## A note on timing

Stage 3 was first run in September with the mechanism active; that run informed the decision to
move on, but its export was incomplete. The confirmed, fully logged run reported in
[`03-dynamic-subgoal.md`](03-dynamic-subgoal.md) was re-run on 2026-10-03 to complete the record,
after work on the follow-up simulator had already begun. It reproduced the picture behind the
decision: the `no_candidates` bottleneck seen in the Stage 2 logs (52%) did not improve when the
motivation text became dynamic (67%).

## What happened next

I adopted two ideas from **[Agentopia: Long-Term Life Simulation and Learning in Agent Societies](https://arxiv.org/abs/2606.07513)**:
its discrete weekly cycle (Plan → Contact → Activity → Review) and its life reward (a social
component computed by PageRank on private like/respect ratings, a subjective well-being component,
and an economic component). With them I rebuilt the island scenario as a turn-based Python
simulator, keeping the same six characters and the same scarcity question.

That design removes the gaps documented above by construction rather than by patching:

| Left unfixed in AI Town | In the turn-based simulator |
|---|---|
| Who meets whom is decided by movement, distance and cooldown before motivation is consulted (`no_candidates` 52-67%) | There is no map: in each message round every agent chooses directly whom to write to, so `no_candidates` cannot occur |
| No persistent memory of specific commitments to specific people | Trade, loan and cooperative-fishing proposals are objects with an id and a status (open / accepted / rejected / expired); loans carry a due day that the simulator enforces, and a default is announced to everyone |
| No sense of whether a prior request was ever followed up | Open proposals, debts and credits are part of each agent's state and shown to it every turn |
| Motivation text overwritten wholesale after each conversation | Persistent per-agent state (weekly plan, diary, impressions of each other agent, a "current mindset" that can change only at season ends and within bounds) |

The price is real: no space, no chance encounters, nothing to watch, and actions chosen from a
fixed menu rather than open-ended behaviour.

The new simulator is used for an A/B experiment in which the only difference between two groups is
the scoring rule the agents are told they will be judged by (individualist vs reputation). It is
documented separately, from design through every rule change to the results, in
**[island-sim](https://github.com/YOUR-USERNAME/island-sim)**.
