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

// ---- 方案1新增：语义动机打分的可调参数 ----
// 后续想做对照实验（比如“关掉动机权重，只看距离”）可以把这几个常量挪到 constants.ts 里，
// 或者直接改成 0/1 做开关。
const MOTIVATION_WEIGHT = 1.0; // 语义相关度（我的plan 和 对方identity/plan的余弦相似度）的权重
const DISTANCE_WEIGHT = 0.6; // 距离惩罚的权重（距离越远分越低）
const RANDOM_EXPLORATION_PROBABILITY = 0.3; // 保留一部分“纯随机/就近”选择，避免社交网络固化成几个固定的对子

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

// ---- 方案1改动核心 ----
// 原来的 findConversationCandidate 是一个 internalQuery，纯按 PLAYER_CONVERSATION_COOLDOWN
// 过滤 + 距离排序。现在拆成两部分：
//   1. loadCandidateContext（internalQuery）：只做数据库读取——保留原有的冷却过滤逻辑，
//      并且额外把“我的 identity+plan”和“每个候选人的 identity+plan（或 description）”读出来。
//   2. findConversationCandidate（改成 internalAction）：因为算 embedding 需要调用
//      Ollama/OpenAI 的网络接口，Convex 的 query 函数不允许发网络请求，所以这一步必须是 action。
//      这里用 embeddingsCache（项目里memory模块已经在用的缓存工具）算“我的plan”和“候选人
//      identity/plan”的语义相似度，作为“动机分”，再和距离分加权，取代原来纯距离排序。

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
    // 方案2新增：是否套用 PLAYER_CONVERSATION_COOLDOWN 过滤。
    // findConversationCandidate（决定发不发邀请）传 true；
    // chooseWanderTarget（决定往哪个方向逛）传 false——
    // 冷却期不该拦住“往TA那边走”，只该拦住“走到了还不能开口”。
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

    // 我自己（发起筛选的这个agent）的 identity + plan，作为“动机文本”的锚点。
    let myPlanText: string | null = null;
    const myAgent = world.agents.find((a) => a.playerId === player.id);
    if (myAgent) {
      const myDescription = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('agentId', myAgent.id))
        .first();
      if (myDescription) {
        // 机制2：把动态刷新的"阶段性目标"也拼进去，不再只看静态的identity+plan。
        myPlanText = `${myDescription.identity} ${myDescription.plan} ${
          myDescription.currentSubGoal ?? ''
        }`.trim();
      }
    }

    const candidates: CandidateWithContext[] = [];

    for (const otherPlayer of otherFreePlayers) {
      // 冷却过滤逻辑：只有 shouldApplyCooldown 为 true 时才生效（原版行为不变）。
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

      // 候选人如果是agent，用identity+plan；如果是人类玩家（没有agent），退化用playerDescription。
      let motivationText: string | null = null;
      const candidateAgent = world.agents.find((a) => a.playerId === otherPlayer.id);
      if (candidateAgent) {
        const candidateDescription = await ctx.db
          .query('agentDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('agentId', candidateAgent.id))
          .first();
        if (candidateDescription) {
          // 候选人自己的阶段性目标也纳入比较——比如Bob的"我需要先想清楚能不能信任大家"
          // 可能比Bob静态的identity文本更贴近Stella当前想匹配的语义。
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

// ---- 日志：记录每一次“选谁发邀请/往哪逛”的完整决策依据 ----
// 写进 agentDecisionLogs 这张新表（需要在 schema.ts 里加），而不是只 console.log，
// 这样可以像 messages/memories 一样直接从 Convex Dashboard 导出成表格分析，
// 不受函数日志保留期限的限制。

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

// 可选：要不要为“动机分选中的目标”额外生成一句自然语言解释。
// 默认关闭——这是让LLM事后对着分数和两段文本做“合理化”，
// 不是决策当下真实发生的推理过程（决策当下唯一真实依据就是余弦相似度这个数字本身）。
// 只在你想要更好读的研究记录、且能接受多一次LLM调用成本时打开。
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

    // 保留一部分“纯随机/就近”选择：
    // 1) 没查到自己的plan文本时（理论上不该发生，兜底）；
    // 2) 按 RANDOM_EXPLORATION_PROBABILITY 的概率主动放弃动机打分。
    // 这样可以避免agent的社交网络很快收敛成几个固定对子，保留一部分“偶然社交”，
    // 这对你想观察的“跨家庭意外接触/立场传播路径”这类现象很重要。
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
          motivationScore: 0, // 这条分支没算动机分，用0表示“未参与打分”
          distance: distance(c.position, player.position),
        })),
      });
      return sorted[0]?.id;
    }

    // 批量拿 embedding：第0个是“我的plan”，后面依次是每个候选人的动机文本。
    // embeddingsCache 内部按文本hash缓存，identity/plan文本在整局游戏里基本不变，
    // 所以除了第一次，后续基本都是缓存命中，不会重复真正调用LLM/embedding接口。
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

// ---- 方案2新增：让“闲逛往哪走”也带目的性 ----
// 只在 agentOperations.ts 的“agent 刚站定、准备闲逛”分支里调用。
// 和 findConversationCandidate 的区别：
//   1. 不套 PLAYER_CONVERSATION_COOLDOWN（冷却期不该拦住“往TA那边走”）。
//   2. 只看语义动机分，不再减距离惩罚——这里要选的是“值得专门走一趟的人”，
//      如果还按“动机分-距离”选，永远会选离得近的人，起不到主动接近远处目标的效果。
//      距离改成用 WANDER_MIN_MOTIVATION_SCORE 这个阈值 + 落地后的抖动来体现，
//      而不是直接参与打分。
const WANDER_TARGET_PROBABILITY = 0.6; // 60%概率“有目的地逛”，40%概率保留纯随机
const WANDER_MIN_MOTIVATION_SCORE = 0.15; // 语义相似度低于这个值，不值得为TA专门改变方向

export const chooseWanderTarget = internalAction({
  args: {
    now: v.number(),
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
  },
  handler: async (ctx: ActionCtx, args): Promise<{ x: number; y: number } | undefined> => {
    const { now, worldId, player, otherFreePlayers } = args;

    // 保留一部分纯随机闲逛，避免每个人一闲下来就精确扑向全场语义最相关的那个人。
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

    // 分数太低，不值得为TA专门改变方向，交回纯随机闲逛——但这次比较过的所有候选人分数照样记下来，
    // 这样能看出“这次其实没人特别合适，所以放弃了”，而不是误以为压根没跑过这套逻辑。
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
