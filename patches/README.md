# `patches/` — how the code is organized

**Scope:** this folder only contains the handful of backend files that this research actually
reads or changes — the social-decision logic in `convex/aiTown/` and `convex/agent/`, plus the two
schema files those changes depend on. It is **not** a copy of the full AI Town project: the
frontend (`src/`, `index.html`), build/deploy tooling (`vite.config.ts`, `Dockerfile`,
`docker-compose.yml`, `fly/`, `vercel.json`, …), dependency manifests, and everything else in the
[original project](https://github.com/a16z-infra/ai-town) are left out on purpose, because none of
it is part of what changed across these four stages. For the full project, clone
`a16z-infra/ai-town` directly.

Within that scope, `00-baseline/` holds the **complete, pristine original code** — exactly as
pulled from `a16z-infra/ai-town` on GitHub — for every one of those backend files. `01-`, `02-`,
`03-` each hold **only the files that were genuinely changed at that stage**, verified by diffing
against `00-baseline/` (not by trusting old folder names — an earlier pass through this repo had
mislabeled a couple of files, see below). A file not listed in a later stage's folder is unchanged
from the previous stage — go back to `00-baseline/` (or the most recent stage that does list it)
to see its actual content at that point.

## Layout

```
patches/
├── 00-baseline/                   # Complete pristine upstream code — the diff base for everything below
│   ├── agent.ts                   # convex/aiTown/agent.ts
│   ├── agentOperations.ts         # convex/aiTown/agentOperations.ts
│   ├── agentDescription.ts        # convex/aiTown/agentDescription.ts  (never changed until Stage 3)
│   ├── memory.ts                  # convex/agent/memory.ts            (never changed until Stage 3)
│   ├── schema.ts                  # convex/schema.ts                  (never changed until Stage 2)
│   └── aiTown-schema.ts           # convex/aiTown/schema.ts           (never changed at any stage)
├── 01-fixed-motivation-invite/    # Solution 1 — motivation score at invite time
│   ├── agent.ts
│   └── agentOperations.ts
├── 02-fixed-motivation-wander/    # Solution 2 — motivation score extended to wander + decision logging
│   ├── agent.ts
│   ├── agentOperations.ts
│   └── schema.ts                  # agentDecisionLogs table added here
└── 03-dynamic-subgoal/            # Mechanism 2 — currentSubGoal, refreshed from memory
    ├── agent.ts
    ├── agentDescription.ts        # currentSubGoal field added here (first real change to this file)
    └── memory.ts                  # generateSubGoal / updateCurrentSubGoal added here
```

## Why some files are missing from a stage

A stage folder only contains a file if that file actually changed at that stage. To reconstruct
the full state of any file at any point, use the most recent folder (reading backwards from the
stage you care about toward `00-baseline/`) that lists it:

- **`agentOperations.ts` is absent from `03-dynamic-subgoal/`** because Stage 3 never touched it —
  it's byte-identical to the Stage 2 version in `02-fixed-motivation-wander/`.
- **`schema.ts` is absent from `03-dynamic-subgoal/`** for the same reason — `agentDecisionLogs`
  was added in Stage 2 and never changed again; use `02-fixed-motivation-wander/schema.ts`.
- **`agentDescription.ts` and `memory.ts` are absent from `01-` and `02-`** because both files were
  still pristine (identical to `00-baseline/`) at those stages — the first real edits happen in
  Stage 3.
- **`aiTown-schema.ts` (i.e. `convex/aiTown/schema.ts`) never appears outside `00-baseline/`** —
  it was never modified at any point in this research arc.

## A note on an earlier mistake

An earlier pass through this repo had filed a file under `02-fixed-motivation-wander/` as
`aiTown-schema.ts`, but its actual contents were the project-root `schema.ts` (the one with
`agentDecisionLogs`), not `convex/aiTown/schema.ts` — a copy-paste/export mislabeling. Re-diffing
every file against the real upstream project (`a16z-infra/ai-town`, same commit the original
checkout was based on) caught this, along with two files that had been included per-stage despite
still being pristine at that point. The structure here reflects what actually changed, confirmed
by `diff`, not what a folder happened to be named.

## Reconstructing a runnable checkout for stage N

```bash
npx create-ai-town my-checkout
cd my-checkout

# convex/aiTown/schema.ts never changes — always from 00-baseline
cp <island-research>/patches/00-baseline/aiTown-schema.ts   convex/aiTown/schema.ts

# agent.ts / agentOperations.ts — use the highest-numbered stage <= N that lists the file
cp <island-research>/patches/02-fixed-motivation-wander/agent.ts            convex/aiTown/agent.ts
cp <island-research>/patches/02-fixed-motivation-wander/agentOperations.ts  convex/aiTown/agentOperations.ts

# project-root schema.ts — first appears in Stage 2
cp <island-research>/patches/02-fixed-motivation-wander/schema.ts   convex/schema.ts

# Stage 3 only: the two files that introduce currentSubGoal
cp <island-research>/patches/03-dynamic-subgoal/agentDescription.ts  convex/aiTown/agentDescription.ts
cp <island-research>/patches/03-dynamic-subgoal/memory.ts            convex/agent/memory.ts
```
