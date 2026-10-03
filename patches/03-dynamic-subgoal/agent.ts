import { ObjectType, v } from 'convex/values';
import { GameId, parseGameId } from './ids';
import { agentId, conversationId, playerId } from './ids';
import { serializedPlayer } from './player';
import { Game } from './game';
import {
  ACTION_TIMEOUT,
  AWKWARD_CONVERSATION_TIMEOUT,
  CONVERSATION_COOLDOWN,
  CONVERSATION_DISTANCE,
  INVITE_ACCEPT_PROBABILITY,
  INVITE_TIMEOUT,
  MAX_CONVERSATION_DURATION,
  MAX_CONVERSATION_MESSAGES,
  MESSAGE_COOLDOWN,
  MIDPOINT_THRESHOLD,
  PLAYER_CONVERSATION_COOLDOWN,
} from '../constants';
import { FunctionArgs } from 'convex/server';
import {
  ActionCtx,
  MutationCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { distance } from '../util/geometry';
import { internal } from '../_generated/api';
import { movePlayer } from './movement';
import { insertInput } from './insertInput';
import * as embeddingsCache from '../agent/embeddingsCache';
import { chatCompletion } from '../util/llm';

const selfInternal = internal.aiTown.agent;

// ---- Solution 1 addition: tunable parameters for semantic motivation scoring ----
// For future ablation experiments (e.g. "turn off motivation weight, use distance only"),
// these constants could be moved to constants.ts, or toggled directly as 0/1 switches.
const MOTIVATION_WEIGHT = 1.0; // weight of semantic relevance (cosine similarity between my plan and the candidate's identity/plan)
const DISTANCE_WEIGHT = 0.6; // weight of the distance penalty (farther away -> lower score)
const RANDOM_EXPLORATION_PROBABILITY = 0.3; // keep some "pure random / nearest" choices so the social network doesn't collapse into a few fixed pairs

export class Agent {
  id: GameId<'agents'>;
  playerId: GameId<'players'>;
  toRemember?: GameId<'conversations'>;
  lastConversation?: number;
  lastInviteAttempt?: number;
  inProgressOperation?: {
    name: string;
    operationId: string;
    started: number;
  };

  constructor(serialized: SerializedAgent) {
    const { id, lastConversation, lastInviteAttempt, inProgressOperation } = serialized;
    const playerId = parseGameId('players', serialized.playerId);
    this.id = parseGameId('agents', id);
    this.playerId = playerId;
    this.toRemember =
      serialized.toRemember !== undefined
        ? parseGameId('conversations', serialized.toRemember)
        : undefined;
    this.lastConversation = lastConversation;
    this.lastInviteAttempt = lastInviteAttempt;
    this.inProgressOperation = inProgressOperation;
  }

  tick(game: Game, now: number) {
    const player = game.world.players.get(this.playerId);
    if (!player) {
      throw new Error(`Invalid player ID ${this.playerId}`);
    }
    if (this.inProgressOperation) {
      if (now < this.inProgressOperation.started + ACTION_TIMEOUT) {
        // Wait on the operation to finish.
        return;
      }
      console.log(`Timing out ${JSON.stringify(this.inProgressOperation)}`);
      delete this.inProgressOperation;
    }
    const conversation = game.world.playerConversation(player);
    const member = conversation?.participants.get(player.id);

    const recentlyAttemptedInvite =
      this.lastInviteAttempt && now < this.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const doingActivity = player.activity && player.activity.until > now;
    if (doingActivity && (conversation || player.pathfinding)) {
      player.activity!.until = now;
    }
    // If we're not in a conversation, do something.
    // If we aren't doing an activity or moving, do something.
    // If we have been wandering but haven't thought about something to do for
    // a while, do something.
    if (!conversation && !doingActivity && (!player.pathfinding || !recentlyAttemptedInvite)) {
      this.startOperation(game, now, 'agentDoSomething', {
        worldId: game.worldId,
        player: player.serialize(),
        otherFreePlayers: [...game.world.players.values()]
          .filter((p) => p.id !== player.id)
          .filter(
            (p) => ![...game.world.conversations.values()].find((c) => c.participants.has(p.id)),
          )
          .map((p) => p.serialize()),
        agent: this.serialize(),
        map: game.worldMap.serialize(),
      });
      return;
    }
    // Check to see if we have a conversation we need to remember.
    if (this.toRemember) {
      // Fire off the action to remember the conversation.
      console.log(`Agent ${this.id} remembering conversation ${this.toRemember}`);
      this.startOperation(game, now, 'agentRememberConversation', {
        worldId: game.worldId,
        playerId: this.playerId,
        agentId: this.id,
        conversationId: this.toRemember,
      });
      delete this.toRemember;
      return;
    }
    if (conversation && member) {
      const [otherPlayerId, otherMember] = [...conversation.participants.entries()].find(
        ([id]) => id !== player.id,
      )!;
      const otherPlayer = game.world.players.get(otherPlayerId)!;
      if (member.status.kind === 'invited') {
        // Accept a conversation with another agent with some probability and with
        // a human unconditionally.
        if (otherPlayer.human || Math.random() < INVITE_ACCEPT_PROBABILITY) {
          console.log(`Agent ${player.id} accepting invite from ${otherPlayer.id}`);
          conversation.acceptInvite(game, player);
          // Stop moving so we can start walking towards the other player.
          if (player.pathfinding) {
            delete player.pathfinding;
          }
        } else {
          console.log(`Agent ${player.id} rejecting invite from ${otherPlayer.id}`);
          conversation.rejectInvite(game, now, player);
        }
        return;
      }
      if (member.status.kind === 'walkingOver') {
        // Leave a conversation if we've been waiting for too long.
        if (member.invited + INVITE_TIMEOUT < now) {
          console.log(`Giving up on invite to ${otherPlayer.id}`);
          conversation.leave(game, now, player);
          return;
        }

        // Don't keep moving around if we're near enough.
        const playerDistance = distance(player.position, otherPlayer.position);
        if (playerDistance < CONVERSATION_DISTANCE) {
          return;
        }

        // Keep moving towards the other player.
        // If we're close enough to the player, just walk to them directly.
        if (!player.pathfinding) {
          let destination;
          if (playerDistance < MIDPOINT_THRESHOLD) {
            destination = {
              x: Math.floor(otherPlayer.position.x),
              y: Math.floor(otherPlayer.position.y),
            };
          } else {
            destination = {
              x: Math.floor((player.position.x + otherPlayer.position.x) / 2),
              y: Math.floor((player.position.y + otherPlayer.position.y) / 2),
            };
          }
          console.log(`Agent ${player.id} walking towards ${otherPlayer.id}...`, destination);
          movePlayer(game, now, player, destination);
        }
        return;
      }
      if (member.status.kind === 'participating') {
        const started = member.status.started;
        if (conversation.isTyping && conversation.isTyping.playerId !== player.id) {
          // Wait for the other player to finish typing.
          return;
        }
        if (!conversation.lastMessage) {
          const isInitiator = conversation.creator === player.id;
          const awkwardDeadline = started + AWKWARD_CONVERSATION_TIMEOUT;
          // Send the first message if we're the initiator or if we've been waiting for too long.
          if (isInitiator || awkwardDeadline < now) {
            // Grab the lock on the conversation and send a "start" message.
            console.log(`${player.id} initiating conversation with ${otherPlayer.id}.`);
            const messageUuid = crypto.randomUUID();
            conversation.setIsTyping(now, player, messageUuid);
            this.startOperation(game, now, 'agentGenerateMessage', {
              worldId: game.worldId,
              playerId: player.id,
              agentId: this.id,
              conversationId: conversation.id,
              otherPlayerId: otherPlayer.id,
              messageUuid,
              type: 'start',
            });
            return;
          } else {
            // Wait on the other player to say something up to the awkward deadline.
            return;
          }
        }
        // See if the conversation has been going on too long and decide to leave.
        const tooLongDeadline = started + MAX_CONVERSATION_DURATION;
        if (tooLongDeadline < now || conversation.numMessages > MAX_CONVERSATION_MESSAGES) {
          console.log(`${player.id} leaving conversation with ${otherPlayer.id}.`);
          const messageUuid = crypto.randomUUID();
          conversation.setIsTyping(now, player, messageUuid);
          this.startOperation(game, now, 'agentGenerateMessage', {
            worldId: game.worldId,
            playerId: player.id,
            agentId: this.id,
            conversationId: conversation.id,
            otherPlayerId: otherPlayer.id,
            messageUuid,
            type: 'leave',
          });
          return;
        }
        // Wait for the awkward deadline if we sent the last message.
        if (conversation.lastMessage.author === player.id) {
          const awkwardDeadline = conversation.lastMessage.timestamp + AWKWARD_CONVERSATION_TIMEOUT;
          if (now < awkwardDeadline) {
            return;
          }
        }
        // Wait for a cooldown after the last message to simulate "reading" the message.
        const messageCooldown = conversation.lastMessage.timestamp + MESSAGE_COOLDOWN;
        if (now < messageCooldown) {
          return;
        }
        // Grab the lock and send a message!
        console.log(`${player.id} continuing conversation with ${otherPlayer.id}.`);
        const messageUuid = crypto.randomUUID();
        conversation.setIsTyping(now, player, messageUuid);
        this.startOperation(game, now, 'agentGenerateMessage', {
          worldId: game.worldId,
          playerId: player.id,
          agentId: this.id,
          conversationId: conversation.id,
          otherPlayerId: otherPlayer.id,
          messageUuid,
          type: 'continue',
        });
        return;
      }
    }
  }

  startOperation<Name extends keyof AgentOperations>(
    game: Game,
    now: number,
    name: Name,
    args: Omit<FunctionArgs<AgentOperations[Name]>, 'operationId'>,
  ) {
    if (this.inProgressOperation) {
      throw new Error(
        `Agent ${this.id} already has an operation: ${JSON.stringify(this.inProgressOperation)}`,
      );
    }
    const operationId = game.allocId('operations');
    console.log(`Agent ${this.id} starting operation ${name} (${operationId})`);
    game.scheduleOperation(name, { operationId, ...args } as any);
    this.inProgressOperation = {
      name,
      operationId,
      started: now,
    };
  }

  serialize(): SerializedAgent {
    return {
      id: this.id,
      playerId: this.playerId,
      toRemember: this.toRemember,
      lastConversation: this.lastConversation,
      lastInviteAttempt: this.lastInviteAttempt,
      inProgressOperation: this.inProgressOperation,
    };
  }
}

export const serializedAgent = {
  id: agentId,
  playerId: playerId,
  toRemember: v.optional(conversationId),
  lastConversation: v.optional(v.number()),
  lastInviteAttempt: v.optional(v.number()),
  inProgressOperation: v.optional(
    v.object({
      name: v.string(),
      operationId: v.string(),
      started: v.number(),
    }),
  ),
};
export type SerializedAgent = ObjectType<typeof serializedAgent>;

type AgentOperations = typeof internal.aiTown.agentOperations;

export async function runAgentOperation(ctx: MutationCtx, operation: string, args: any) {
  let reference;
  switch (operation) {
    case 'agentRememberConversation':
      reference = internal.aiTown.agentOperations.agentRememberConversation;
      break;
    case 'agentGenerateMessage':
      reference = internal.aiTown.agentOperations.agentGenerateMessage;
      break;
    case 'agentDoSomething':
      reference = internal.aiTown.agentOperations.agentDoSomething;
      break;
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
  await ctx.scheduler.runAfter(0, reference, args);
}

export const agentSendMessage = internalMutation({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    agentId,
    playerId,
    text: v.string(),
    messageUuid: v.string(),
    leaveConversation: v.boolean(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('messages', {
      conversationId: args.conversationId,
      author: args.playerId,
      text: args.text,
      messageUuid: args.messageUuid,
      worldId: args.worldId,
    });
    await insertInput(ctx, args.worldId, 'agentFinishSendingMessage', {
      conversationId: args.conversationId,
      agentId: args.agentId,
      timestamp: Date.now(),
      leaveConversation: args.leaveConversation,
      operationId: args.operationId,
    });
  },
});

// ---- Core of the Solution 1 change ----
// The original findConversationCandidate was an internalQuery that filtered purely by
// PLAYER_CONVERSATION_COOLDOWN and sorted by distance. It's now split into two parts:
//   1. loadCandidateContext (internalQuery): database reads only -- keeps the original
//      cooldown-filtering logic, and additionally loads "my identity+plan" and each
      // candidate's identity+plan (or description).
//   2. findConversationCandidate (now an internalAction): computing embeddings requires
//      calling the Ollama/OpenAI network API, which a Convex query cannot do -- so this
      // step must be an action.
//      This uses embeddingsCache (the caching utility already used by the memory module)
//      to compute the semantic similarity between "my plan" and each candidate's
      // identity/plan as the "motivation score", then weights it against the distance
      // score, replacing the original pure-distance sort.

type CandidateWithContext = {
  id: string;
  position: { x: number; y: number };
  motivationText: string | null;
};

export const loadCandidateContext = internalQuery({
  args: {
    now: v.number(),
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
    // Solution 2 addition: whether to apply the PLAYER_CONVERSATION_COOLDOWN filter.
    // findConversationCandidate (decides whether to send an invite) passes true;
    // chooseWanderTarget (decides which direction to wander) passes false --
    // cooldown shouldn't block "walking toward them", only "arriving but still not being able to talk".
    applyCooldown: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { now, worldId, player, otherFreePlayers, applyCooldown },
  ): Promise<{ myPlanText: string | null; candidates: CandidateWithContext[] }> => {
    const shouldApplyCooldown = applyCooldown ?? true;
    const world = await ctx.db.get(worldId);
    if (!world) {
      throw new Error(`World ${worldId} not found`);
    }

    // My own (the agent running this selection) identity + plan, as the anchor for the "motivation text".
    let myPlanText: string | null = null;
    const myAgent = world.agents.find((a) => a.playerId === player.id);
    if (myAgent) {
      const myDescription = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('agentId', myAgent.id))
        .first();
      if (myDescription) {
        // Mechanism 2: also fold in the dynamically-refreshed "current sub-goal", not just the static identity+plan.
        myPlanText = `${myDescription.identity} ${myDescription.plan} ${
          myDescription.currentSubGoal ?? ''
        }`.trim();
      }
    }

    const candidates: CandidateWithContext[] = [];

    for (const otherPlayer of otherFreePlayers) {
      // Cooldown-filtering logic: only takes effect when shouldApplyCooldown is true (original behavior unchanged).
      if (shouldApplyCooldown) {
        const lastMember = await ctx.db
          .query('participatedTogether')
          .withIndex('edge', (q) =>
            q.eq('worldId', worldId).eq('player1', player.id).eq('player2', otherPlayer.id),
          )
          .order('desc')
          .first();
        if (lastMember && now < lastMember.ended + PLAYER_CONVERSATION_COOLDOWN) {
          continue;
        }
      }

      // If the candidate is an agent, use identity+plan; if it's a human player (no agent), fall back to playerDescription.
      let motivationText: string | null = null;
      const candidateAgent = world.agents.find((a) => a.playerId === otherPlayer.id);
      if (candidateAgent) {
        const candidateDescription = await ctx.db
          .query('agentDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('agentId', candidateAgent.id))
          .first();
        if (candidateDescription) {
          // The candidate's own sub-goal is folded into the comparison too -- e.g. Bob's "I need to
          // figure out whether I can trust everyone first" may match what Stella is currently
          // looking for better than Bob's static identity text does.
          motivationText = `${candidateDescription.identity} ${candidateDescription.plan} ${
            candidateDescription.currentSubGoal ?? ''
          }`.trim();
        }
      }
      if (!motivationText) {
        const playerDescription = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('playerId', otherPlayer.id))
          .first();
        motivationText = playerDescription?.description ?? null;
      }

      candidates.push({
        id: otherPlayer.id,
        position: otherPlayer.position,
        motivationText,
      });
    }

    return { myPlanText, candidates };
  },
});

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---- Logging: record the full decision basis for every "who to invite / where to wander" choice ----
// Written into the new agentDecisionLogs table (added in schema.ts) rather than just console.log,
// so it can be exported as a table from the Convex Dashboard for analysis, just like
// messages/memories -- without being limited by function-log retention.

function truncateText(text: string, maxLength = 160): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export const logAgentDecision = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    decisionType: v.union(v.literal('invite'), v.literal('wander')),
    branch: v.union(
      v.literal('motivation'),
      v.literal('random_exploration'),
      v.literal('no_candidates'),
      v.literal('no_plan_text'),
      v.literal('below_threshold'),
    ),
    chosenId: v.optional(v.string()),
    myPlanSnippet: v.optional(v.string()),
    chosenSnippet: v.optional(v.string()),
    explanation: v.optional(v.string()),
    candidates: v.array(
      v.object({
        id: v.string(),
        motivationScore: v.number(),
        distance: v.optional(v.number()),
        finalScore: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('agentDecisionLogs', {
      ...args,
      timestamp: Date.now(),
    });
  },
});

// Optional: whether to also generate a natural-language explanation for the target chosen by the motivation score.
// Off by default -- this has the LLM "rationalize" after the fact from the scores and the two text snippets,
// two text snippets; it is not the reasoning that actually happened at decision time (the
// only real basis at decision time is the cosine-similarity number itself).
// Turn it on only when you want a more readable research record and can accept the cost of one extra LLM call.
const ENABLE_LLM_EXPLANATION = false;

async function explainChoice(
  ctx: ActionCtx,
  myPlanText: string,
  chosenText: string,
): Promise<string | undefined> {
  if (!ENABLE_LLM_EXPLANATION) {
    return undefined;
  }
  try {
    const { content } = await chatCompletion({
      messages: [
        {
          role: 'user',
          content:
            `My goal/personality: "${myPlanText}"\n` +
            `A person I might approach: "${chosenText}"\n` +
            `In one short sentence, explain why this person could be relevant to my goal.`,
        },
      ],
      max_tokens: 60,
    });
    return content.trim();
  } catch (e) {
    console.error('explainChoice failed', e);
    return undefined;
  }
}

export const findConversationCandidate = internalAction({
  args: {
    now: v.number(),
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
  },
  handler: async (ctx: ActionCtx, args): Promise<string | undefined> => {
    const { now, worldId, player, otherFreePlayers } = args;
    const { myPlanText, candidates } = await ctx.runQuery(selfInternal.loadCandidateContext, {
      now,
      worldId,
      player,
      otherFreePlayers,
      applyCooldown: true,
    });

    if (candidates.length === 0) {
      await ctx.runMutation(selfInternal.logAgentDecision, {
        worldId,
        playerId: player.id,
        decisionType: 'invite',
        branch: 'no_candidates',
        candidates: [],
      });
      return undefined;
    }

    // Keep some "pure random / nearest" choices:
    // 1) when my own plan text can't be found (shouldn't happen in theory -- a fallback);
    // 2) with probability RANDOM_EXPLORATION_PROBABILITY, deliberately skip motivation scoring.
    // This keeps agents' social network from quickly converging into a few fixed pairs,
    // preserving some "chance encounters" --
    // important for observing things like cross-family incidental contact or belief-propagation paths.
    if (!myPlanText || Math.random() < RANDOM_EXPLORATION_PROBABILITY) {
      const sorted = [...candidates].sort(
        (a: CandidateWithContext, b: CandidateWithContext) =>
          distance(a.position, player.position) - distance(b.position, player.position),
      );
      await ctx.runMutation(selfInternal.logAgentDecision, {
        worldId,
        playerId: player.id,
        decisionType: 'invite',
        branch: myPlanText ? 'random_exploration' : 'no_plan_text',
        chosenId: sorted[0]?.id,
        myPlanSnippet: myPlanText ? truncateText(myPlanText) : undefined,
        candidates: candidates.map((c: CandidateWithContext) => ({
          id: c.id,
          motivationScore: 0, // this branch never computed a motivation score; 0 means "did not take part in scoring"
          distance: distance(c.position, player.position),
        })),
      });
      return sorted[0]?.id;
    }

    // Fetch embeddings in a batch: index 0 is "my plan", followed by each candidate's motivation text in order.
    // embeddingsCache caches internally by text hash; identity/plan text barely changes over
    // the course of a game, so apart from the first call, this is almost always a cache hit and doesn't re-invoke the LLM/embedding API.
    const texts: string[] = [
      myPlanText,
      ...candidates.map((c: CandidateWithContext) => c.motivationText ?? c.id),
    ];
    const { embeddings } = await embeddingsCache.fetchBatch(ctx, texts);
    const myEmbedding: number[] | undefined = embeddings[0];

    const maxDistance = Math.max(
      ...candidates.map((c: CandidateWithContext) => distance(c.position, player.position)),
      1,
    );

    type ScoredCandidate = {
      id: string;
      motivationScore: number;
      rawDistance: number;
      finalScore: number;
    };

    const scored: ScoredCandidate[] = candidates.map(
      (c: CandidateWithContext, i: number): ScoredCandidate => {
        const candidateEmbedding: number[] | undefined = embeddings[i + 1];
        const motivationScore =
          myEmbedding && candidateEmbedding ? cosineSimilarity(myEmbedding, candidateEmbedding) : 0;
        const rawDistance = distance(c.position, player.position);
        const normalizedDistance = rawDistance / maxDistance;
        const finalScore = MOTIVATION_WEIGHT * motivationScore - DISTANCE_WEIGHT * normalizedDistance;
        return { id: c.id, motivationScore, rawDistance, finalScore };
      },
    );

    scored.sort((a: ScoredCandidate, b: ScoredCandidate) => b.finalScore - a.finalScore);
    const winner = scored[0];
    const winnerCandidate = candidates.find((c: CandidateWithContext) => c.id === winner?.id);

    let explanation: string | undefined;
    if (winner && winnerCandidate?.motivationText) {
      explanation = await explainChoice(ctx, myPlanText, winnerCandidate.motivationText);
    }

    await ctx.runMutation(selfInternal.logAgentDecision, {
      worldId,
      playerId: player.id,
      decisionType: 'invite',
      branch: 'motivation',
      chosenId: winner?.id,
      myPlanSnippet: truncateText(myPlanText),
      chosenSnippet: winnerCandidate?.motivationText
        ? truncateText(winnerCandidate.motivationText)
        : undefined,
      explanation,
      candidates: scored.map((s: ScoredCandidate) => ({
        id: s.id,
        motivationScore: s.motivationScore,
        distance: s.rawDistance,
        finalScore: s.finalScore,
      })),
    });

    return winner?.id;
  },
});

// ---- Solution 2 addition: giving "which way to wander" a purpose too ----
// Called only from agentOperations.ts's "agent just stopped, about to wander" branch.
// Differences from findConversationCandidate:
//   1. Does not apply PLAYER_CONVERSATION_COOLDOWN (cooldown shouldn't block "walking toward them").
//   2. Only looks at the semantic motivation score, no distance penalty subtracted -- the
      // goal here is "someone worth making a special trip for"; scoring by
      // motivation-minus-distance would always pick whoever is nearby and defeat the point
      // of proactively approaching a distant target.
//      Distance is instead expressed via the WANDER_MIN_MOTIVATION_SCORE threshold plus
//      post-landing jitter, rather than entering the score directly.
const WANDER_TARGET_PROBABILITY = 0.6; // 60% chance of "wandering with a purpose", 40% chance of staying purely random
const WANDER_MIN_MOTIVATION_SCORE = 0.15; // below this semantic-similarity value, it's not worth changing direction just for them

export const chooseWanderTarget = internalAction({
  args: {
    now: v.number(),
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
  },
  handler: async (ctx: ActionCtx, args): Promise<{ x: number; y: number } | undefined> => {
    const { now, worldId, player, otherFreePlayers } = args;

    // Keep some purely random wandering, so agents don't all beeline for whoever is semantically most relevant the moment they're idle.
    if (Math.random() > WANDER_TARGET_PROBABILITY) {
      await ctx.runMutation(selfInternal.logAgentDecision, {
        worldId,
        playerId: player.id,
        decisionType: 'wander',
        branch: 'random_exploration',
        candidates: [],
      });
      return undefined;
    }

    const { myPlanText, candidates } = await ctx.runQuery(selfInternal.loadCandidateContext, {
      now,
      worldId,
      player,
      otherFreePlayers,
      applyCooldown: false,
    });

    if (!myPlanText || candidates.length === 0) {
      await ctx.runMutation(selfInternal.logAgentDecision, {
        worldId,
        playerId: player.id,
        decisionType: 'wander',
        branch: !myPlanText ? 'no_plan_text' : 'no_candidates',
        candidates: [],
      });
      return undefined;
    }

    const texts: string[] = [
      myPlanText,
      ...candidates.map((c: CandidateWithContext) => c.motivationText ?? c.id),
    ];
    const { embeddings } = await embeddingsCache.fetchBatch(ctx, texts);
    const myEmbedding: number[] | undefined = embeddings[0];
    if (!myEmbedding) {
      await ctx.runMutation(selfInternal.logAgentDecision, {
        worldId,
        playerId: player.id,
        decisionType: 'wander',
        branch: 'no_plan_text',
        candidates: [],
      });
      return undefined;
    }

    type WanderScore = { id: string; position: { x: number; y: number }; motivationScore: number };
    const allScores: WanderScore[] = candidates.map((c: CandidateWithContext, i: number) => {
      const candidateEmbedding: number[] | undefined = embeddings[i + 1];
      const motivationScore = candidateEmbedding
        ? cosineSimilarity(myEmbedding, candidateEmbedding)
        : 0;
      return { id: c.id, position: c.position, motivationScore };
    });

    let best: WanderScore | undefined;
    for (const s of allScores) {
      if (!best || s.motivationScore > best.motivationScore) {
        best = s;
      }
    }

    // Score too low to be worth changing direction for -- falls back to purely random wandering --
    // so it's clear "no one was actually a good fit this time" rather than looking like this logic never ran.
    if (!best || best.motivationScore < WANDER_MIN_MOTIVATION_SCORE) {
      await ctx.runMutation(selfInternal.logAgentDecision, {
        worldId,
        playerId: player.id,
        decisionType: 'wander',
        branch: 'below_threshold',
        chosenId: best?.id,
        myPlanSnippet: truncateText(myPlanText),
        candidates: allScores.map((s: WanderScore) => ({
          id: s.id,
          motivationScore: s.motivationScore,
        })),
      });
      return undefined;
    }

    const winnerCandidate = candidates.find((c: CandidateWithContext) => c.id === best?.id);
    let explanation: string | undefined;
    if (winnerCandidate?.motivationText) {
      explanation = await explainChoice(ctx, myPlanText, winnerCandidate.motivationText);
    }

    await ctx.runMutation(selfInternal.logAgentDecision, {
      worldId,
      playerId: player.id,
      decisionType: 'wander',
      branch: 'motivation',
      chosenId: best.id,
      myPlanSnippet: truncateText(myPlanText),
      chosenSnippet: winnerCandidate?.motivationText
        ? truncateText(winnerCandidate.motivationText)
        : undefined,
      explanation,
      candidates: allScores.map((s: WanderScore) => ({
        id: s.id,
        motivationScore: s.motivationScore,
      })),
    });

    return best.position;
  },
});
