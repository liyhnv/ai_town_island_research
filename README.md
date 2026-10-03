# Does Motivation Matter? Patching Social Choice into a Multi-Agent Simulation

A research log from a summer internship at the National Center for Applied Mathematics,
Southern University of Science and Technology (SUSTech), using
[AI Town](https://github.com/a16z-infra/ai-town) — an open-source multi-agent town simulation —
as a testbed for studying how cooperative or hoarding norms emerge among agents under resource
scarcity.

**TL;DR:** AI Town's agents never read their own goals when deciding *who* to talk to — only
*what* to say once a conversation has already started. I patched that in three increasingly
sophisticated stages, built a decision-logging system to make every choice auditable, and used
that same logging system to show — quantitatively — that patch-based fixes hit a structural
ceiling. That finding is what moved the project toward a different kind of framework
([Agentopia](https://arxiv.org/abs/2606.07513)) built around persistent agent goals from the
start, rather than one with motivation retrofitted on top.

## The setup

Six characters — Lucky, Kurt, Stella, Alice, Bob, Pete — are stranded on an island after a
shipwreck with limited food. Each has a persona and a private stance on whether to pool resources
or protect their own family's stock. The question: does the group converge toward cooperation,
toward hoarding, or fragment — and what in the simulation's mechanics determines that?

## How to read this repo

| Folder | What's in it |
|---|---|
| [`docs/`](docs/) | The actual research narrative, one file per stage — read these in order |
| [`patches/`](patches/) | The changed source files at each stage (not a full AI Town checkout — see below) |
| [`data/`](data/) | Exported run data (decision logs, memories, messages, descriptions) per stage |
| [`analysis/`](analysis/) | The script used to compute the branch-distribution stats cited in the docs |

### Narrative, in order

1. **[Diagnosing the baseline](docs/01-baseline-problem.md)** — why the stock AI Town engine's
   partner-selection logic never reads agent identity/plan.
2. **[Patching in a fixed motivation score](docs/02-fixed-motivation.md)** — embedding-based
   scoring added at invite time, then extended to idle "wander" behavior; plus the decision-logging
   system that made the results falsifiable instead of anecdotal.
3. **[From static text to memory-updated motivation](docs/03-dynamic-subgoal.md)** — letting an
   agent's current sub-goal update after every conversation, and what that exposed about
   information loss and a persistent upstream bottleneck.
4. **[Why I moved past patching](docs/04-why-pivot-to-agentopia.md)** — the quantitative case for
   why this was the point to stop iterating on AI Town's engine and look at frameworks built
   around persistent agent state from the ground up.

## A note on `patches/`

This repo does **not** include a full AI Town checkout (dependencies, generated Convex code,
assets, etc. — see the [original project](https://github.com/a16z-infra/ai-town) for that). Each
`patches/NN-stage/` folder holds only the files that were added or changed at that stage, so the
diffs between stages are easy to read directly. To actually run a given stage, drop its files into
a fresh `npx create-ai-town` checkout at the matching paths (`convex/aiTown/*.ts`,
`convex/agent/memory.ts`, `convex/schema.ts`).

## Reproducing the stats

```bash
pip install openpyxl
python analysis/decision_log_stats.py data/03-dynamic-subgoal/decisionlogs.xlsx
```

prints the branch-distribution table (motivation / random_exploration / no_candidates / ...) that
the docs cite, directly from the raw exported decision log.
