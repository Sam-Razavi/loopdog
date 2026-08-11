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
}

const problems: string[] = [];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    problems.push(`${name} is missing`);
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
    problems.push(`LOOPDOG_TZ is not a valid IANA timezone: "${tz}"`);
  }
  return tz;
}

function cutoffHour(): number {
  const raw = optional("LOOPDOG_DAY_CUTOFF_HOUR", "4");
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    problems.push(`LOOPDOG_DAY_CUTOFF_HOUR must be an integer 0-23, got "${raw}"`);
    return 4;
  }
  return hour;
}

function effort(): Effort {
  const raw = optional("LOOPDOG_EFFORT", "low");
  if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    problems.push(
      `LOOPDOG_EFFORT must be one of ${EFFORT_LEVELS.join(", ")}, got "${raw}"`,
    );
    return "low";
  }
  return raw as Effort;
}

export const config: Config = {
  discordToken: required("DISCORD_TOKEN"),
  ownerId: required("DISCORD_OWNER_ID"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  timezone: timezone(),
  dayCutoffHour: cutoffHour(),
  userName: optional("LOOPDOG_USER_NAME", "you"),
  userNickname: optional("LOOPDOG_USER_NICKNAME", ""),
  dbPath: optional("LOOPDOG_DB", "./loopdog.sqlite"),
  effort: effort(),
  model: "claude-sonnet-5",
};

/**
 * Called once at boot, before anything touches the network or the database.
 * Reports every problem at once rather than one per restart.
 */
export function assertConfigured(): void {
  if (problems.length === 0) return;
  throw new Error(
    `Loopdog is not configured:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nCopy .env.example to .env and fill it in.`,
  );
}
