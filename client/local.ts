// Browser-only demo: runs the whole simulation inside the page with the offline mock mind.
// No server, no API key — this is what the GitHub Pages demo uses.
import { SPEEDS, TICK_RATE, type ClientMessage, type ServerMessage } from '../shared/protocol';
import { applyAdmin } from '../server/admin';
import { LLMGateway } from '../server/mind/gateway';
import { MockProvider } from '../server/mind/providers/mock';
import { Simulation } from '../server/sim';

export interface Transport {
  send(msg: ClientMessage): void;
}

const newSeed = () => Math.floor(Math.random() * 1_000_000_000);

export function startLocalSimulation(onMessage: (msg: ServerMessage) => void): Transport {
  const llm = new LLMGateway(new MockProvider(400), {
    maxCallsPerMinute: 120,
    maxConcurrent: 4,
    dailyTokenBudget: Number.MAX_SAFE_INTEGER,
    timeoutMs: 10_000,
  });
  const seedParam = Number(new URLSearchParams(location.search).get('seed'));
  let sim = new Simulation(seedParam || newSeed(), llm);

  const init = (): ServerMessage => ({
    type: 'init',
    world: sim.world.map,
    agents: sim.agentStates(),
    clock: sim.clock,
    events: sim.events.slice(-50),
    llm: llm.stats(),
    blueprints: [...sim.blueprints.values()],
    achievements: sim.achievements.unlocks,
    saveName: null,
  });
  const drain = () => {
    sim.drainEvents();
    sim.world.drainChanges();
    sim.world.drainAdded();
    sim.world.drainRemoved();
    sim.drainBlueprints();
    sim.achievements.drain();
  };

  let ticks = 0;
  setInterval(() => {
    for (let i = 0; i < sim.speed; i++) sim.step();
    onMessage({
      type: 'state',
      agents: sim.agentStates(),
      clock: sim.clock,
      events: sim.drainEvents(),
      objects: sim.world.drainChanges(),
      newObjects: sim.world.drainAdded(),
      removedObjects: sim.world.drainRemoved(),
      blueprints: sim.drainBlueprints(),
      achievements: sim.achievements.drain(),
      llm: llm.stats(),
      economy: ticks++ % 10 === 0 ? sim.economyStats() : null,
    });
  }, 1000 / TICK_RATE);

  // Deliver the first frame asynchronously, like a network would.
  setTimeout(() => {
    drain();
    onMessage(init());
  }, 0);

  return {
    send(msg) {
      switch (msg.type) {
        case 'setSpeed':
          if ((SPEEDS as readonly number[]).includes(msg.speed)) sim.speed = msg.speed;
          break;
        case 'regenerate': {
          const speed = sim.speed;
          sim = new Simulation(newSeed(), llm);
          sim.speed = speed;
          drain();
          onMessage(init());
          break;
        }
        case 'setMind':
          llm.enabled = Boolean(msg.enabled);
          break;
        case 'admin':
          applyAdmin(sim, msg);
          break;
        case 'save':
        case 'listSaves':
        case 'load':
          onMessage({ type: 'notice', text: 'Saving and loading are available when you run Agent Aquarium locally.' });
          break;
      }
    },
  };
}
