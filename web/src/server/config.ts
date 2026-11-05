import { randomBytes } from 'node:crypto';
import type { Config } from './context.js';

const num = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

export function loadConfig(): Config {
  let cookieSecret = process.env.GUEST_COOKIE_SECRET;
  if (!cookieSecret) {
    if (process.env.NODE_ENV === 'production') throw new Error('GUEST_COOKIE_SECRET is required in production');
    cookieSecret = randomBytes(32).toString('hex');
    console.warn('[config] GUEST_COOKIE_SECRET not set; using an ephemeral secret');
  }
  return {
    port: num('PORT', 8080),
    cookieSecret,
    copilotToken: process.env.COPILOT_GITHUB_TOKEN || undefined,
    copilotModel: process.env.COPILOT_MODEL || undefined,
    evaluatorUrl: process.env.EVALUATOR_URL ?? 'http://localhost:8081',
    demoBoardOrigin: process.env.DEMO_BOARD_ORIGIN ?? 'http://localhost:8080',
    browserbaseApiKey: process.env.BROWSERBASE_API_KEY || undefined,
    limits: {
      maxItems: num('LIMIT_MAX_ITEMS', 20),
      maxDetails: num('LIMIT_MAX_DETAILS', 10),
      runSeconds: num('LIMIT_RUN_SECONDS', 180),
      modelCalls: num('LIMIT_MODEL_CALLS', 40),
      runsPerHour: num('LIMIT_RUNS_PER_HOUR', 5),
      prepPerHour: num('LIMIT_PREP_PER_HOUR', 30),
      assistantPerHour: num('LIMIT_ASSISTANT_PER_HOUR', 40),
      guestsPerIpHour: num('LIMIT_GUESTS_PER_IP_HOUR', 10),
      browserSessions: num('LIMIT_BROWSER_SESSIONS', 3),
    },
  };
}
