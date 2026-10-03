import { ObjectType, v } from 'convex/values';
import { GameId, agentId, parseGameId } from './ids';

export class AgentDescription {
  agentId: GameId<'agents'>;
  identity: string;
  plan: string;
  // 机制2新增：随对话结果动态刷新的"阶段性目标"，比如"我还需要Bob和Pete的承诺"。
  // 和 identity/plan 不同，这个字段整局游戏里会不断被 rememberConversation 覆盖更新。
  currentSubGoal?: string;

  constructor(serialized: SerializedAgentDescription) {
    const { agentId, identity, plan, currentSubGoal } = serialized;
    this.agentId = parseGameId('agents', agentId);
    this.identity = identity;
    this.plan = plan;
    this.currentSubGoal = currentSubGoal;
  }

  serialize(): SerializedAgentDescription {
    const { agentId, identity, plan, currentSubGoal } = this;
    return { agentId, identity, plan, currentSubGoal };
  }
}

export const serializedAgentDescription = {
  agentId,
  identity: v.string(),
  plan: v.string(),
  currentSubGoal: v.optional(v.string()),
};
export type SerializedAgentDescription = ObjectType<typeof serializedAgentDescription>;
