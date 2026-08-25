import "dotenv/config";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface Config {
  discordToken: string;
  ownerId: string;
  anthropicApiKey: string;
  timezone: string;
  dayCutoffHour: number;
  userName: string;
  userNickname: string;
  dbPath: string;
  effort: Effort;
  model: string;
  pushIntervalMinutes: number;
  atRiskNudgeHour: number;
  digestHour: number;
}

// Split in two so a Discord-free entry point (the REPL) can validate without
// demanding Discord credentials it has no use for. Everything the agent
// itself needs lands in coreProblems; Discord-only requirements are separate.
const coreProblems: string[] = [];
const discordProblems: string[] = [];

function requiredInto(name: string, bucket: string[]): string {
  const value = process.env[name]?.trim();
  if (!value) {
    bucket.push(`${name} is missing`);
    return "";
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function timezone(): string {
  const tz = optional("LOOPDOG_TZ", "Europe/Stockholm");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    coreProblems.push(`LOOPDOG_TZ is not a valid IANA timezone: "${tz}"`);
  }
  return tz;
}

function cutoffHour(): number {
  const raw = optional("LOOPDOG_DAY_CUTOFF_HOUR", "4");
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    coreProblems.push(`LOOPDOG_DAY_CUTOFF_HOUR must be an integer 0-23, got "${raw}"`);
    return 4;
  }
  return hour;
}

function effort(): Effort {
  const raw = optional("LOOPDOG_EFFORT", "low");
  if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    coreProblems.push(
      `LOOPDOG_EFFORT must be one of ${EFFORT_LEVELS.join(", ")}, got "${raw}"`,
    );
    return "low";
  }
  return raw as Effort;
}

function pushIntervalMinutes(): number {
  const raw = optional("LOOPDOG_PUSH_INTERVAL_MINUTES", "5");
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1) {
    coreProblems.push(
      `LOOPDOG_PUSH_INTERVAL_MINUTES must be a positive integer, got "${raw}"`,
    );
    return 5;
  }
  return minutes;
}

function atRiskNudgeHour(): number {
  const raw = optional("LOOPDOG_AT_RISK_NUDGE_HOUR", "21");
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    coreProblems.push(`LOOPDOG_AT_RISK_NUDGE_HOUR must be an integer 0-23, got "${raw}"`);
    return 21;
  }
  return hour;
}

function digestHour(): number {
  const raw = optional("LOOPDOG_DIGEST_HOUR", "20");
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    coreProblems.push(`LOOPDOG_DIGEST_HOUR must be an integer 0-23, got "${raw}"`);
    return 20;
  }
  return hour;
}

export const config: Config = {
  discordToken: requiredInto("DISCORD_TOKEN", discordProblems),
  ownerId: requiredInto("DISCORD_OWNER_ID", discordProblems),
  anthropicApiKey: requiredInto("ANTHROPIC_API_KEY", coreProblems),
  timezone: timezone(),
  dayCutoffHour: cutoffHour(),
  userName: optional("LOOPDOG_USER_NAME", "you"),
  userNickname: optional("LOOPDOG_USER_NICKNAME", ""),
  dbPath: optional("LOOPDOG_DB", "./loopdog.sqlite"),
  effort: effort(),
  model: "claude-sonnet-5",
  pushIntervalMinutes: pushIntervalMinutes(),
  atRiskNudgeHour: atRiskNudgeHour(),
  digestHour: digestHour(),
};

function report(problems: string[], hint: string): void {
  if (problems.length === 0) return;
  throw new Error(
    `Loopdog is not configured:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\n${hint}`,
  );
}

/**
 * What the agent itself needs — the Anthropic key and behavior settings.
 * Called by the REPL, which has no Discord dependency at all.
 */
export function assertAgentConfigured(): void {
  report(coreProblems, "Copy .env.example to .env and fill in at least ANTHROPIC_API_KEY.");
}

/**
 * Everything, including Discord credentials. Called once at boot by the
 * Discord entry point, before anything touches the network or the database.
 */
export function assertDiscordConfigured(): void {
  report([...coreProblems, ...discordProblems], "Copy .env.example to .env and fill it in.");
}
