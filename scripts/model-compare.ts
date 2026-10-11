// Compares OpenRouter models on the same scenario: valid JSON, quality, latency, cost.
// Usage: npx tsx scripts/model-compare.ts <model> [model…]   (needs OPENAI_API_KEY = an OpenRouter key)
import '../server/env';
import { createGateway } from '../server/mind/config';
import { DECISION_SCHEMA, parseDecision } from '../server/mind/decision';
import { observe, systemPrompt, userPrompt } from '../server/mind/perception';
import { OpenAICompatibleProvider } from '../server/mind/providers/openai';
import { Simulation } from '../server/sim';

const models = process.argv.slice(2);
const off = createGateway({ LLM_PROVIDER: 'mock' });
off.enabled = false;
const sim = new Simulation(42, off);
for (let i = 0; i < 900; i++) sim.step();
const agents = [sim.agents[3], sim.agents[1]]; // different personalities
const prices = new Map<string, [number, number]>();
const list = (await (await fetch('https://openrouter.ai/api/v1/models')).json()) as { data: { id: string; pricing: { prompt: string; completion: string } }[] };
for (const m of list.data) prices.set(m.id, [Number(m.pricing.prompt) * 1e6, Number(m.pricing.completion) * 1e6]);

await Promise.all(
  models.map(async (model) => {
    const p = new OpenAICompatibleProvider(process.env.OPENAI_API_KEY!, model, 'https://openrouter.ai/api/v1');
    const lines: string[] = [];
    let ok = 0, tin = 0, tout = 0, ms = 0;
    for (const agent of agents) {
      const t0 = Date.now();
      try {
        const res = await p.complete(
          { system: systemPrompt(agent), user: userPrompt(observe(agent, sim.makeCtx())), schema: DECISION_SCHEMA },
          AbortSignal.timeout(40_000),
        );
        ms += Date.now() - t0;
        tin += res.inputTokens;
        tout += res.outputTokens;
        const d = parseDecision(res.text);
        if (d) {
          ok++;
          lines.push(`   ${agent.name}: ${d.action}${d.target !== 'none' ? ' ' + d.target : ''}${d.who ? ' ' + d.who : ''} — 💭 ${d.thought.slice(0, 140)}`);
        } else lines.push(`   ${agent.name}: INVALID JSON → ${res.text.slice(0, 100)}`);
      } catch (e) {
        lines.push(`   ${agent.name}: ERROR ${(e as Error).message.slice(0, 120)}`);
      }
    }
    const [pi, po] = prices.get(model) ?? [0, 0];
    const perCall = ok ? ((tin * pi + tout * po) / 1e6) / agents.length : 0;
    const perHour = perCall * 30 * 60; // at the default rate limit
    console.log(`\n■ ${model}  valid ${ok}/${agents.length}  ~${ok ? Math.round(ms / ok) : '-'} ms  $${perCall.toFixed(6)} per call  (at most ~$${perHour.toFixed(3)}/hour)\n${lines.join('\n')}`);
  }),
);
