// Sends two real decision requests to your configured LLM: do the key, model and JSON schema work?
// Usage: npx tsx scripts/llm-ping.ts
import '../server/env';
import { createGateway } from '../server/mind/config';
import { DECISION_SCHEMA, parseDecision } from '../server/mind/decision';
import { observe, systemPrompt, userPrompt } from '../server/mind/perception';
import { Simulation } from '../server/sim';

const llm = createGateway();
console.log(`Provider: ${llm.provider.name} / ${llm.provider.model}`);
const off = createGateway({ LLM_PROVIDER: 'mock' });
off.enabled = false;
const sim = new Simulation(42, off);
for (let i = 0; i < 600; i++) sim.step();
const agent = sim.agents[1];
const t0 = Date.now();
for (const round of [1, 2]) {
  const text = await llm.request({ system: systemPrompt(agent), user: userPrompt(observe(agent, sim.makeCtx())), schema: DECISION_SCHEMA });
  const d = parseDecision(text);
  console.log(
    `\n#${round} (${Date.now() - t0} ms) ${agent.name}:`,
    d ? `${d.action} ${d.target !== 'none' ? d.target : ''}${d.who}\n   💭 ${d.thought}${d.say ? `\n   💬 ${d.say}` : ''}${d.plan ? `\n   🎯 ${d.plan}` : ''}` : `INVALID: ${text.slice(0, 200)}`,
  );
}
const s = llm.stats();
console.log(`\nTokens: ${s.inputTokens} in (${s.cacheReadTokens} from cache) + ${s.outputTokens} out · est. $${s.costUsd?.toFixed(5) ?? '?'}`);
