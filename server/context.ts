import type { Blueprint } from '../shared/invention';
import type { WorldClock } from '../shared/protocol';
import type { Market } from './economy/market';
import type { SimEvent } from './events';
import type { Wars } from './social/war';
import type { Agent } from './agent';
import type { LLMGateway } from './mind/gateway';
import type { Rng } from './rng';
import type { World } from './world';

/** Everything agents and tasks can access during one simulation step. */
export interface SimContext {
  world: World;
  agents: Agent[];
  rng: Rng;
  clock: WorldClock;
  llm: LLMGateway;
  log(text: string, agentId?: string): void;
  /** Starts a conversation between two inhabitants; false if they aren't available. */
  startConversation(a: Agent, b: Agent, opener: string | null): boolean;
  blueprints: Map<string, Blueprint>;
  addBlueprint(bp: Blueprint): void;
  emit(event: SimEvent): void;
  /** Creates a helper bound to its owner from a golem recipe. */
  spawnGolem(owner: Agent, bp: Blueprint): void;
  /** Two inhabitants decided to start a family: an egg is laid. */
  startFamily(a: Agent, b: Agent): boolean;
  /** Removes an agent from the world (e.g. a golem whose power ran out). */
  removeAgent(agent: Agent, reason: string): void;
  /** Death: the agent is removed, a gravestone is placed, loved ones mourn. */
  killAgent(agent: Agent, cause: string): void;
  market: Market;
  wars: Wars;
}
