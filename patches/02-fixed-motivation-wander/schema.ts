import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  // Used for Solution 1/2 research: records the full decision basis for every "who to
  // invite" (invite) or "which direction to wander" (wander) choice -- not just who was
  // finally picked, but the raw score comparison across all candidates at the time, so
  // "why them and not someone else" can be reconstructed later instead of seeing only a black-box result.
  agentDecisionLogs: defineTable({
    worldId: v.id('worlds'),
    playerId,
    decisionType: v.union(v.literal('invite'), v.literal('wander')),
    // Which branch was taken:
    //   motivation         = genuinely picked by the motivation score
    //   random_exploration = hit the probability branch that preserves randomness
    //   no_candidates      = zero candidates left after filtering
    //   no_plan_text       = my own plan text couldn't be found (a fallback branch that shouldn't happen in theory)
    //   below_threshold    = even the top score didn't reach WANDER_MIN_MOTIVATION_SCORE (wander only)
    branch: v.union(
      v.literal('motivation'),
      v.literal('random_exploration'),
      v.literal('no_candidates'),
      v.literal('no_plan_text'),
      v.literal('below_threshold'),
    ),
    chosenId: v.optional(v.string()),
    // For human review of "why": a leading excerpt of my own plan text and the selected
    // candidate's identity/plan text.
    myPlanSnippet: v.optional(v.string()),
    chosenSnippet: v.optional(v.string()),
    // Optional: have the LLM generate a one-sentence natural-language explanation for this choice after the fact.
    // Note -- this is "post-hoc attribution", not the reasoning that actually happened at
    // decision time; the only real basis at decision time is the scores in candidates below.
    explanation: v.optional(v.string()),
    // All candidates considered in this decision, not only the winner.
    candidates: v.array(
      v.object({
        id: v.string(),
        motivationScore: v.number(), // cosine similarity, the raw semantic-relevance score
        distance: v.optional(v.number()), // raw distance (unnormalized); empty when the wander branch does not factor in distance
        finalScore: v.optional(v.number()), // final score after weighting motivation score against the distance penalty (the wander branch looks at motivation score only, equal to motivationScore)
      }),
    ),
    timestamp: v.number(),
  }).index('worldId', ['worldId', 'timestamp']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
