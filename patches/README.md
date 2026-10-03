# `patches/` — how the code is organized

Each stage folder holds **only the files that were genuinely changed at that stage**, verified by
diffing against a pristine `a16z-infra/ai-town` checkout (not by trusting old folder names — an
earlier pass through this repo had mislabeled a couple of files, see below). A file that isn't
listed in a stage's folder is unchanged from the previous stage; follow the pointers below to see
which earlier folder actually holds it.

## Layout

```
patches/
├── _shared-unchanged/        # Confirmed byte-for-byte identical to upstream across ALL stages
│   └── aiTown-schema.ts      # (convex/aiTown/schema.ts — never touched by this research)
├── 00-baseline/               # Unmodified engine, kept here as the diff base
│   ├── agent.ts
│   └── agentOperations.ts
├── 01-fixed-motivation-invite/   # Solution 1 — motivation score at invite time
│   ├── agent.ts
│   └── agentOperations.ts
├── 02-fixed-motivation-wander/   # Solution 2 — motivation score extended to wander + decision logging
│   ├── agent.ts
│   ├── agentOperations.ts
│   └── schema.ts              # project-root schema.ts — agentDecisionLogs table added here
└── 03-dynamic-subgoal/        # Mechanism 2 — currentSubGoal, refreshed from memory
    ├── agent.ts
    ├── agentDescription.ts    # currentSubGoal field added here (first real change to this file)
    └── memory.ts              # generateSubGoal / updateCurrentSubGoal added here
```

## Why some files are missing from a stage

- **`agentOperations.ts` is absent from `03-dynamic-subgoal/`** because Stage 3 never touched it —
  it's byte-identical to the Stage 2 version. Use `02-fixed-motivation-wander/agentOperations.ts`
  when reconstructing a full Stage 3 checkout.
- **`schema.ts` is absent from `03-dynamic-subgoal/`** for the same reason — `agentDecisionLogs`
  was added in Stage 2 and never changed again. Use `02-fixed-motivation-wander/schema.ts`.
- **`agentDescription.ts` and `memory.ts` are absent from `01-fixed-motivation-invite/` and
  `02-fixed-motivation-wander/`** because both files were still pristine at those stages — the
  first real edits to them happen in Stage 3 (`currentSubGoal` + `generateSubGoal`).
- **`convex/aiTown/schema.ts` never appears in a per-stage folder** — it was never modified at any
  point in this research arc, so it lives once in `_shared-unchanged/` instead of being repeated
  (or, worse, silently duplicated with drift) in every stage folder.

## A note on an earlier mistake

An earlier pass through this repo had filed a file under `02-fixed-motivation-wander/` as
`aiTown-schema.ts`, but its actual contents were the project-root `schema.ts` (the one with
`agentDecisionLogs`), not `convex/aiTown/schema.ts` — a copy-paste/export mislabeling. Re-diffing
every file in `patches/` against the real upstream project caught this, along with the two
not-actually-changed files above that were previously (incorrectly) included per-stage. The
corrected structure here reflects what actually changed, confirmed by `diff`, not what a folder
happened to be named.

## Reconstructing a runnable checkout for stage N

```bash
npx create-ai-town my-checkout
cd my-checkout
cp <island-research>/patches/_shared-unchanged/aiTown-schema.ts   convex/aiTown/schema.ts
cp <island-research>/patches/00-baseline/agent.ts                 convex/aiTown/agent.ts        # or the matching stage
cp <island-research>/patches/00-baseline/agentOperations.ts       convex/aiTown/agentOperations.ts
# Stage 2+: project-root schema.ts
cp <island-research>/patches/02-fixed-motivation-wander/schema.ts convex/schema.ts
# Stage 3: the two files that introduce currentSubGoal
cp <island-research>/patches/03-dynamic-subgoal/agentDescription.ts convex/aiTown/agentDescription.ts
cp <island-research>/patches/03-dynamic-subgoal/memory.ts           convex/agent/memory.ts
```
