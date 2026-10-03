import { ConvexError, v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { WorldMap, serializedWorldMap } from './worldMap';
import { rememberConversation } from '../agent/memory';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { serializedAgent } from './agent';
import { ACTIVITIES, ACTIVITY_COOLDOWN, CONVERSATION_COOLDOWN } from '../constants';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { serializedPlayer } from './player';

// Retries `sendInput` a few times if it hits a "generation number mismatch"
// (an optimistic-concurrency conflict from multiple agents writing at once),
// instead of letting the whole operation fail and get stuck forever.
async function sendInputWithRetry(ctx: any, args: any, maxRetries = 5): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ctx.runMutation(api.aiTown.main.sendInput, args);
    } catch (e) {
      const isGenerationMismatch =
        e instanceof ConvexError && (e.data as any)?.kind === 'generationNumber';
      if (!isGenerationMismatch || attempt === maxRetries) {
        throw e;
      }
      console.log(
        `sendInput hit a generation number mismatch, retrying (attempt ${attempt + 1}/${maxRetries})...`,
      );
      await sleep(200 + Math.random() * 400);
    }
  }
}

export const agentRememberConversation = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await rememberConversation(
      ctx,
      args.worldId,
      args.agentId as GameId<'agents'>,
      args.playerId as GameId<'players'>,
      args.conversationId as GameId<'conversations'>,
    );
    await sleep(Math.random() * 1000);
    await sendInputWithRetry(ctx, {
      worldId: args.worldId,
      name: 'finishRememberConversation',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    });
  },
});

export const agentGenerateMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    otherPlayerId: playerId,
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    let completionFn;
    switch (args.type) {
      case 'start':
        completionFn = startConversationMessage;
        break;
      case 'continue':
        completionFn = continueConversationMessage;
        break;
      case 'leave':
        completionFn = leaveConversationMessage;
        break;
      default:
        assertNever(args.type);
    }
    const text = await completionFn(
      ctx,
      args.worldId,
      args.conversationId as GameId<'conversations'>,
      args.playerId as GameId<'players'>,
      args.otherPlayerId as GameId<'players'>,
    );

    await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
      worldId: args.worldId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      playerId: args.playerId,
      text,
      messageUuid: args.messageUuid,
      leaveConversation: args.type === 'leave',
      operationId: args.operationId,
    });
  },
});

export const agentDoSomething = internalAction({
  args: {
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    agent: v.object(serializedAgent),
    map: v.object(serializedWorldMap),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { player, agent } = args;
    const map = new WorldMap(args.map);
    const now = Date.now();
    // Don't try to start a new conversation if we were just in one.
    const justLeftConversation =
      agent.lastConversation && now < agent.lastConversation + CONVERSATION_COOLDOWN;
    // Don't try again if we recently tried to find someone to invite.
    const recentlyAttemptedInvite =
      agent.lastInviteAttempt && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const recentActivity = player.activity && now < player.activity.until + ACTIVITY_COOLDOWN;
    // Decide whether to do an activity or wander somewhere.
    if (!player.pathfinding) {
      if (recentActivity || justLeftConversation) {
        // Solution 2 addition: before wandering, first ask "is there anyone in particular I want to find".
        // Note this isn't subject to CONVERSATION_COOLDOWN (chooseWanderTarget internally queries
        // with applyCooldown: false) -- cooldown shouldn't block "walking toward them",
        // only the later "arrived but still can't speak" step (which still goes through findConversationCandidate).
        const wanderTarget = await ctx.runAction(internal.aiTown.agent.chooseWanderTarget, {
          now,
          worldId: args.worldId,
          player: args.player,
          otherFreePlayers: args.otherFreePlayers,
        });
        const destination = wanderTarget
          ? wanderTowards(map, wanderTarget)
          : wanderDestination(map);
        await sleep(Math.random() * 1000);
        await sendInputWithRetry(ctx, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            destination,
          },
        });
        return;
      } else {
        // TODO: have LLM choose the activity & emoji
        const activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        await sleep(Math.random() * 1000);
        await sendInputWithRetry(ctx, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        });
        return;
      }
    }
    const invitee =
      justLeftConversation || recentlyAttemptedInvite
        ? undefined
        : await ctx.runAction(internal.aiTown.agent.findConversationCandidate, { // changed from Query to Action
            now,
            worldId: args.worldId,
            player: args.player,
            otherFreePlayers: args.otherFreePlayers,
          });

    await sleep(Math.random() * 1000);
    await sendInputWithRetry(ctx, {
      worldId: args.worldId,
      name: 'finishDoSomething',
      args: {
        operationId: args.operationId,
        agentId: args.agent.id,
        invitee,
      },
    });
  },
});

function wanderDestination(worldMap: WorldMap) {
  // Wander someonewhere at least one tile away from the edge.
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}

// Solution 2 addition: used during "purposeful wandering" -- walks toward the target chosen by chooseWanderTarget,
// chosen by chooseWanderTarget, with a bit of random jitter added so as not to land
// exactly on top of them, while keeping the destination within the map bounds.
const WANDER_JITTER_TILES = 4;

function wanderTowards(worldMap: WorldMap, target: { x: number; y: number }) {
  const jitter = () => Math.floor((Math.random() - 0.5) * 2 * WANDER_JITTER_TILES);
  const x = clamp(Math.floor(target.x) + jitter(), 1, worldMap.width - 2);
  const y = clamp(Math.floor(target.y) + jitter(), 1, worldMap.height - 2);
  return { x, y };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
