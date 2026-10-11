// Asks specific inhabitants of your saved world "what would you do now?" with the real model (the world is not changed).
// Usage: npx tsx scripts/decision-probe.ts <name> [name…]   (needs an autosave in saves/)
import '../server/env';
import { createGateway } from '../server/mind/config';
import { DECISION_SCHEMA, parseDecision } from '../server/mind/decision';
import { observe, systemPrompt, userPrompt } from '../server/mind/perception';
import { loadSimulation } from '../server/persistence';

const llm = createGateway();
const off = createGateway({ LLM_PROVIDER: 'mock' });
off.enabled = false;
const sim = loadSimulation('autosave', off)!;
const names = process.argv.slice(2);
await Promise.all(
  sim.agents
    .filter((a) => names.includes(a.name))
    .map(async (a) => {
      const text = await llm.request({ system: systemPrompt(a), user: userPrompt(observe(a, sim.makeCtx())), schema: DECISION_SCHEMA });
      const d = parseDecision(text);
      console.log(`\n■ ${a.name} (aggression ${a.personality.aggression}) → ${d?.action} ${d?.who || d?.target || ''}\n  💭 ${d?.thought}${d?.say ? `\n  💬 ${d.say}` : ''}`);
    }),
);
console.log(`\nCost: $${llm.stats().costUsd?.toFixed(4) ?? '?'}`);
