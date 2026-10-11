// Prints the prompt an agent would send to the LLM (for prompt tuning).
// Usage: npx tsx scripts/prompt-preview.ts [agent-name] [ticks] [seed]
import { createGateway } from '../server/mind/config';
import { observe, systemPrompt, userPrompt } from '../server/mind/perception';
import { Simulation } from '../server/sim';

const [name = 'Pip', ticks = '700', seed = '42'] = process.argv.slice(2);
const llm = createGateway({ LLM_PROVIDER: 'mock' });
llm.enabled = false;
const sim = new Simulation(Number(seed), llm);
for (let i = 0; i < Number(ticks); i++) sim.step();
const agent = sim.agents.find((a) => a.name === name) ?? sim.agents[0];
const system = systemPrompt(agent);
const user = userPrompt(observe(agent, sim.makeCtx()));
console.log(`===== SYSTEM =====\n${system}\n\n===== USER =====\n${user}\n`);
console.log(`~${Math.round((system.length + user.length) / 4)} tokens (rough estimate)`);
