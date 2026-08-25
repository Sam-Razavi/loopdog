/**
 * Talk to Loopdog in a terminal — the exact same tool-use loop, prompt and
 * SQLite state that Discord uses (src/agent.ts), with no Discord involved at
 * all. Needs only ANTHROPIC_API_KEY; run with `npm run chat`.
 *
 * This exists so personality and tool-calling behavior can be tested the
 * moment an API key is available, without a bot invite, a token, or a
 * running Discord client.
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { assertAgentConfigured, config } from "./config";
import { respond } from "./agent";
import { migrate } from "./db";

async function main(): Promise<void> {
  assertAgentConfigured();
  migrate();

  console.log(
    `Loopdog (local) — ${config.timezone}, day rolls over at ${config.dayCutoffHour}:00.`,
  );
  console.log(
    `Talking to ${config.model}, state in ${config.dbPath}. "exit" or Ctrl+D to quit.\n`,
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question("you> ")).trim();
      } catch {
        break; // Ctrl+D closes the input stream, which rejects question()
      }
      if (!line) continue;
      if (["exit", "quit"].includes(line.toLowerCase())) break;

      try {
        const { text, attachment } = await respond(line);
        console.log(`loop> ${text}`);
        if (attachment) console.log(`      (backup written to ${attachment})`);
        console.log("");
      } catch (error) {
        console.error("error:", error instanceof Error ? error.message : error);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
