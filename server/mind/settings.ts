// Runtime-tunable mind settings, kept free of provider imports so the browser demo can use them.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const num = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : fallback);

/** Minimum simulation ticks between two LLM decisions of the same agent. */
export const minThinkTicks = () => num(env.LLM_MIN_THINK_TICKS, 150);
