import { ObjectType, v } from 'convex/values';
import { GameId, agentId, parseGameId } from './ids';

export class AgentDescription {
  agentId: GameId<'agents'>;
  identity: string;
  plan: string;
  // Mechanism 2 addition: a "current sub-goal" that's dynamically refreshed based on
  // conversation outcomes, e.g. "I still need Bob and Pete's commitment." Unlike
  // identity/plan, this field is continuously overwritten by rememberConversation
  // throughout the game.
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
