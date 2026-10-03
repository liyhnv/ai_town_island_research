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

## At a glance

| Stage | Core change | What it exposed | Data captured | Code |
|---|---|---|---|---|
| 0 — Baseline | *(none — diagnosis only)* | Partner selection reads only distance + cooldown, never `identity`/`plan` | 2026-09-06, 13:44–14:33 (49 min, 237 msgs) | [`patches/00-baseline/`](patches/00-baseline/) |
| 1 — Fixed motivation (invite) | Embedding-similarity score added to `findConversationCandidate` | Only fires when agent is already pathfinding | 2026-09-08, 13:04–13:36 (32 min, 98 msgs) — *same continuous world as Stage 0, code hot-deployed mid-run* | [`patches/01-fixed-motivation-invite/`](patches/01-fixed-motivation-invite/) |
| 2 — Fixed motivation (wander) | Same scoring extended to idle "wander" decisions; decision-log system added | `no_candidates` branch still dominates invite decisions (52% of 209 logged) | 2026-09-13, 12:48–13:37 core capture (49 min, 250 msgs); full world ran to 09-15 14:44, decision-log window 14:20–14:43 (23 min, 209 decisions) | [`patches/02-fixed-motivation-wander/`](patches/02-fixed-motivation-wander/) |
| 3 — Dynamic sub-goal | `currentSubGoal` regenerated from memory after each conversation | `no_candidates` *worse* (67% of 568), motivation-driven share *drops* (28.7% → 19.5%) despite smarter scoring text | 2026-10-03, 02:46–03:44 UTC (58 min, 568 decisions, 42 memories) | [`patches/03-dynamic-subgoal/`](patches/03-dynamic-subgoal/) |
| → Pivot | — | Three rounds of increasingly sophisticated patches couldn't move the bottleneck — it's upstream of any scoring logic | — | — |

Full reasoning, code excerpts, and the TypeScript/deployment issues hit along the way are in
[`docs/`](docs/), one file per row above, read in order.

## How to read this repo

| Folder | What's in it |
|---|---|
| [`docs/`](docs/) | The actual research narrative, one file per stage — **read these in order**, the table above is just a map |
| [`patches/`](patches/) | Only the backend decision-logic files this research touches (not a full AI Town checkout — see the note below). `00-baseline/` holds the complete, pristine original version of each of those files; `01-`/`02-`/`03-` each hold only the files that genuinely changed at that stage — see [`patches/README.md`](patches/README.md) for the full map and why a couple of files aren't where an earlier pass through this repo first put them |
| [`data/`](data/) | Exported run data per stage: raw Convex table exports (`.xlsx` from the dashboard UI, `.jsonl` from the dashboard's raw export) — message transcripts, agent memories, agent descriptions, and (from Stage 2 onward) decision logs |
| [`analysis/`](analysis/) | `decision_log_stats.py` — the script that produces the percentages cited in `docs/` and the table above, runs on either `.xlsx` or `.jsonl` decision-log exports |

### Narrative, in order

1. **[Diagnosing the baseline](docs/01-baseline-problem.md)** — why the stock AI Town engine's
   partner-selection logic never reads agent identity/plan.
2. **[Patching in a fixed motivation score](docs/02-fixed-motivation.md)** — embedding-based
   scoring added at invite time, then extended to idle "wander" behavior; the decision-logging
   system that made results falsifiable; and a deployment bug the logs caught by accident.
3. **[From static text to memory-updated motivation](docs/03-dynamic-subgoal.md)** — letting an
   agent's current sub-goal update after every conversation, what that exposed about information
   loss, and the confirmed data showing the upstream bottleneck persisted anyway.
4. **[Why I moved past patching](docs/04-why-pivot-to-agentopia.md)** — the quantitative case for
   stopping iteration on AI Town's engine and looking at frameworks built around persistent agent
   state from the ground up.

## A note on `patches/`

`patches/` only holds the handful of **backend decision-logic files this research actually
changes** — not a full AI Town checkout. The original project also includes a frontend (`src/`,
`index.html`), build/deploy tooling (`vite.config.ts`, `Dockerfile`, `docker-compose.yml`, `fly/`,
`vercel.json`, …), and dependency manifests — none of that is touched by this research, so none of
it is duplicated here. See the [original project](https://github.com/a16z-infra/ai-town) for the
full codebase.

Within that narrower scope, `patches/00-baseline/` holds the complete, pristine original code —
straight from `a16z-infra/ai-town` on GitHub — for every one of those backend files. Each later
`patches/NN-stage/` folder holds only the files **genuinely** changed at that stage, verified by
diffing against `00-baseline/` rather than by trusting old folder/file names (an earlier pass
through this repo had a couple of files mislabeled or duplicated; see
[`patches/README.md`](patches/README.md) for what was wrong and how it was caught). This keeps the
diff between `00-baseline/` and any stage, or between any two stages, a direct file-to-file
comparison rather than something you have to extract from two full checkouts. To actually run a
given stage, see the reconstruction recipe in [`patches/README.md`](patches/README.md).

## Reproducing the stats

```bash
pip install openpyxl
python analysis/decision_log_stats.py data/03-dynamic-subgoal/decisionlogs.jsonl
python analysis/decision_log_stats.py data/02-fixed-motivation-wander/decisionlog-export/decisionlogs.xlsx
```

prints the branch-distribution table (motivation / random_exploration / no_candidates / ...) that
`docs/` and the table above cite, directly from the raw exported decision log.
