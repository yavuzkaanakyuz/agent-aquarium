// Scenario tests for the simulation. Every test builds a fresh, seeded world — no saves, no API keys.
// Run with: npm test
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DAY_TICKS } from '../shared/protocol';
import type { Agent } from '../server/agent';
import { Market } from '../server/economy/market';
import { validateDesign, type Design } from '../server/invention/engine';
import { createGateway } from '../server/mind/config';
import { parseDecision } from '../server/mind/decision';
import { Simulation } from '../server/sim';
import { AttackTask, formAlliance } from '../server/social/combat';
import { RaidTask } from '../server/social/war';
import { SleepTask } from '../server/tasks';

// Saves go to a temp dir (SAVE_DIR is read when the persistence module loads).
const saveDir = mkdtempSync(join(tmpdir(), 'aquarium-test-'));
process.env.SAVE_DIR = saveDir;
const { loadSimulation, saveSimulation } = await import('../server/persistence');
after(() => rmSync(saveDir, { recursive: true, force: true }));

/** A deterministic world whose mind is switched off (reflexes only). */
function world(seed = 42) {
  const llm = createGateway({ LLM_PROVIDER: 'mock' });
  llm.enabled = false;
  const sim = new Simulation(seed, llm);
  const logs: string[] = [];
  const log = sim.log.bind(sim);
  sim.log = (text, id) => (logs.push(text), log(text, id));
  sim.step();
  return { sim, logs, run: (ticks: number) => { for (let t = 0; t < ticks; t++) sim.step(); } };
}

const adults = (sim: Simulation) => sim.agents.filter((a) => !a.isGolem && a.stage === 'adult');
const placeTogether = (...agents: Agent[]) => {
  const { x, y } = agents[0].tile;
  for (const a of agents) Object.assign(a, { x: x + 0.5, y: y + 0.5, path: [], task: null });
};

describe('survival', () => {
  test('agents keep themselves fed for several days', () => {
    const { sim, logs, run } = world();
    run(DAY_TICKS * 3);
    assert.equal(logs.filter((l) => /fainted/.test(l)).length, 0);
    assert.ok(sim.agents.every((a) => a.needs.health > 50));
  });

  test('a starving agent with berries in the bag eats immediately', () => {
    const { sim, run } = world();
    const a = adults(sim)[0];
    Object.assign(a.needs, { food: 0, health: 3, energy: 20 });
    a.inventory.berry = 5;
    a.task = new SleepTask(false);
    run(40);
    assert.ok(sim.agents.includes(a), 'agent should survive');
    assert.ok(a.needs.food > 15);
  });

  test('without food an agent searches, faints, dies and leaves a grave', () => {
    const { sim, logs, run } = world();
    sim.world.setScarcity(50, 1);
    const a = adults(sim)[0];
    a.needs.food = 0;
    delete a.inventory.berry;
    run(DAY_TICKS * 2);
    assert.ok(!sim.agents.includes(a));
    assert.ok(logs.some((l) => l.includes(`${a.name} died`)));
    assert.ok(sim.world.map.objects.some((o) => o.structure?.shape === 'grave'));
  });
});

describe('world', () => {
  test('building next to someone never traps them', () => {
    const { sim } = world();
    const a = adults(sim)[0];
    const { x, y } = a.tile;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!sim.world.isFree(x + dx, y + dy) || sim.world.wouldTrap(x + dx, y + dy, [a.tile])) continue;
      sim.world.addStructure(x + dx, y + dy, {
        blueprintId: 't', name: 'Wall', kind: 'structure', shape: 'wall', color: '#999', ownerId: a.id, ownerName: a.name, shelter: 0, light: 0, defense: 0,
      });
    }
    assert.ok(sim.world.reachableCount(x, y, 25) >= 25);
  });
});

describe('inventions', () => {
  const design = (over: Partial<Design>): Design => ({
    thought: '', name: 'Stone Axe', kind: 'tool', description: '', components: [{ type: 'harvest', power: 1 }],
    materials: { wood: 2, stone: 1 }, shape: 'axe', color: '#999', ...over,
  });

  test('a reasonable recipe validates', () => {
    const { sim } = world();
    const a = adults(sim)[0];
    a.inventory = { wood: 2, stone: 1 };
    assert.deepEqual(validateDesign(design({}), a), []);
  });

  test('flight is locked below tech level 4 and budgets are enforced', () => {
    const { sim } = world();
    const a = adults(sim)[0];
    a.inventory = { wood: 6, fiber: 4 };
    const errors = validateDesign(design({ kind: 'vehicle', components: [{ type: 'flight', power: 3 }], materials: { wood: 6, fiber: 4 }, shape: 'glider' }), a);
    assert.ok(errors.some((e) => /tech level 4/.test(e)));
    assert.ok(errors.some((e) => /power can be at most/.test(e)));
  });
});

describe('conflict', () => {
  test('an attack draws in allies and hurts the target', () => {
    const { sim, logs, run } = world();
    const [a, b, c] = adults(sim);
    placeTogether(a, b, c);
    Object.assign(a.personality, { aggression: 0.9, caution: 0.1 });
    Object.assign(c.personality, { aggression: 0.7 });
    a.equipment.push({ blueprintId: 'x', name: 'Club', kind: 'weapon', components: [{ type: 'damage', power: 3 }], shape: 'sword', color: '#999', uses: null });
    formAlliance(b, c, sim.makeCtx());
    a.task = new AttackTask(b);
    run(300);
    assert.ok(logs.some((l) => l.includes(`${a.name} attacked ${b.name}`)));
    assert.ok(logs.some((l) => l.includes(`to defend their ally ${b.name}`)));
    assert.ok(b.relations.get(a.id).affection < 0);
  });

  test('a siege raid razes an enemy home', () => {
    const { sim, logs, run } = world();
    const [a, b] = adults(sim);
    const { x, y } = b.tile;
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: x + dx, y: y + dy })).find((p) => sim.world.isFree(p.x, p.y))!;
    const home = sim.world.addStructure(spot.x, spot.y, {
      blueprintId: 'h', name: 'Hut', kind: 'structure', shape: 'hut', color: '#c70', ownerId: b.id, ownerName: b.name, shelter: 1, light: 0, defense: 0,
    });
    b.homeId = home.id;
    sim.wars.declare(a, b, sim.makeCtx());
    a.equipment.push({ blueprintId: 'c', name: 'Catapult', kind: 'vehicle', components: [{ type: 'damage', power: 3 }], shape: 'catapult', color: '#555', uses: 5 });
    placeTogether(a);
    Object.assign(a, { x: b.x, y: b.y });
    a.task = new RaidTask(home);
    run(600);
    assert.equal(sim.world.objectById(home.id), undefined);
    assert.ok(logs.some((l) => /razed/.test(l)));
  });
});

describe('evolution', () => {
  test('two close friends lay an egg that hatches into a mixed child', () => {
    const { sim, logs, run } = world();
    const [a, b] = adults(sim);
    placeTogether(a, b);
    for (const [x, y] of [[a, b], [b, a]] as const) x.relations.adjust(y.id, { affection: 0.8, trust: 0.6, familiarity: 0.5 });
    for (const p of [a, b]) Object.assign(p.needs, { food: 90, energy: 90 }), p.addItem('berry', 3);
    assert.equal(sim.makeCtx().startFamily(a, b), true);
    run(DAY_TICKS);
    const child = sim.agents.find((x) => x.parents.includes(a.id));
    assert.ok(child, 'child exists');
    assert.equal(child.stage, 'child');
    assert.ok(logs.some((l) => /hatched/.test(l)));
  });
});

describe('economy', () => {
  test('crossing orders match at the resting price and settle into accounts', () => {
    const { sim } = world();
    const [seller, buyer] = adults(sim);
    const market = new Market();
    seller.inventory = { wood: 5 };
    buyer.inventory = { berry: 10 };
    const ctx = sim.makeCtx();
    assert.equal(market.place(seller, 'sell', 'wood', 3, 2, ctx), null);
    assert.equal(market.place(buyer, 'buy', 'wood', 3, 3, ctx), null);
    assert.equal(market.trades.length, 1);
    assert.equal(market.trades[0].price, 2);
    assert.equal(market.accounts.get(seller.id)?.berry, 6);
    assert.equal(market.accounts.get(buyer.id)?.wood, 3);
    assert.equal(market.accounts.get(buyer.id)?.berry, 3); // refund of the 1-berry difference ×3
  });
});

describe('persistence & mind', () => {
  test('a saved world loads back identically', () => {
    const { sim, run } = world();
    run(500);
    const name = saveSimulation(sim, 'roundtrip');
    const llm = createGateway({ LLM_PROVIDER: 'mock' });
    const loaded = loadSimulation(name, llm)!;
    assert.equal(loaded.clock.day, sim.clock.day);
    assert.deepEqual(loaded.agents.map((a) => [a.name, Math.round(a.knowledge), a.stage]), sim.agents.map((a) => [a.name, Math.round(a.knowledge), a.stage]));
  });

  test('malformed model output is rejected instead of crashing', () => {
    assert.equal(parseDecision('not json'), null);
    assert.equal(parseDecision('{"action":"fly_to_the_moon"}'), null);
    assert.equal(parseDecision('{"action":"gather","target":"wood"}')?.action, 'gather');
  });
});
