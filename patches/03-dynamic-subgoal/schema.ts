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

  // 方案1/方案2研究用：记录每一次"选谁发邀请"(invite)或"往哪个方向闲逛"(wander)的
  // 完整决策依据——不只存最终选中的人，存下当时所有候选人的原始分数对比，
  // 这样之后能逐条还原"为什么是TA、不是别人"，而不是只看到一个黑箱结果。
  agentDecisionLogs: defineTable({
    worldId: v.id('worlds'),
    playerId,
    decisionType: v.union(v.literal('invite'), v.literal('wander')),
    // 走的是哪条分支：
    //   motivation         = 真的按动机分选出来的
    //   random_exploration = 命中了保留随机性的那个概率分支
    //   no_candidates      = 候选人过滤完是0个
    //   no_plan_text       = 没查到自己的plan文本（理论上不该发生的兜底分支）
    //   below_threshold    = 最高分也没到WANDER_MIN_MOTIVATION_SCORE（仅wander场景）
    branch: v.union(
      v.literal('motivation'),
      v.literal('random_exploration'),
      v.literal('no_candidates'),
      v.literal('no_plan_text'),
      v.literal('below_threshold'),
    ),
    chosenId: v.optional(v.string()),
    // 用于人眼核对"为什么"：我的plan文本、被选中那位的identity/plan文本，各截取前一段。
    myPlanSnippet: v.optional(v.string()),
    chosenSnippet: v.optional(v.string()),
    // 可选：让LLM针对这次选择事后生成一句自然语言解释。
    // 注意——这是"事后归因"，不是决策当下真实发生的推理过程，
    // 决策当下唯一真实依据就是下面candidates里的分数本身。
    explanation: v.optional(v.string()),
    // 这次决策考虑过的所有候选人，不只是赢家。
    candidates: v.array(
      v.object({
        id: v.string(),
        motivationScore: v.number(), // 余弦相似度，语义相关度的原始分
        distance: v.optional(v.number()), // 原始距离（未归一化），wander分支不参与距离计算时为空
        finalScore: v.optional(v.number()), // 动机分和距离惩罚加权后的最终分（wander分支只看动机分，等于motivationScore）
      }),
    ),
    timestamp: v.number(),
  }).index('worldId', ['worldId', 'timestamp']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
