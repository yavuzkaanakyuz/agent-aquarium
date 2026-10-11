// Fast simulation without graphics or LLM — for tuning the balance settings.
// Usage: npx tsx scripts/headless.ts [days] [seed]
import { DAY_TICKS } from '../shared/protocol';
import { createGateway } from '../server/mind/config';
import { Simulation } from '../server/sim';

const days = Number(process.argv[2] ?? 5);
// A synchronous loop can't wait for LLM replies, so only the reflex layer runs here.
const llm = createGateway({ LLM_PROVIDER: 'mock' });
llm.enabled = false;
const sim = new Simulation(Number(process.argv[3] ?? 42), llm);
const allEvents: string[] = [];
const origLog = sim.log.bind(sim);
sim.log = (text, agentId) => (allEvents.push(text), origLog(text, agentId));
const t0 = performance.now();
for (let d = 1; d <= days; d++) {
  for (let i = 0; i < DAY_TICKS; i++) sim.step();
  const rows = sim.agents.map((a) => {
    const n = a.needs;
    const inv = Object.entries(a.inventory).map(([k, v]) => `${k}:${v}`).join(' ');
    return `  ${a.name.padEnd(6)} food ${n.food.toFixed(0).padStart(3)} energy ${n.energy.toFixed(0).padStart(3)} hp ${n.health.toFixed(0).padStart(3)} | ${inv}`;
  });
  console.log(`— end of day ${d} —\n${rows.join('\n')}`);
}
const count = (re: RegExp) => allEvents.filter((t) => re.test(t)).length;
console.log(`\n${allEvents.length} events: fainted ${count(/fainted/)}, hungry ${count(/is hungry/)}, berries ${count(/picked berries/)}, wood ${count(/chopped wood/)}, stone ${count(/broke stone/)}, waves ${count(/waved at/)}`);
console.log(`${days * DAY_TICKS} ticks in ${(performance.now() - t0).toFixed(0)} ms`);
