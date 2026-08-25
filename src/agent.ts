import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { appendTurn, recentTurns } from "./db/history";
import { buildSystemPrompt } from "./prompt";
import { runTool, ToolError, TOOLS } from "./tools";

const MAX_TOOL_ROUNDS = 6;
const HISTORY_TURNS = 20;
const MAX_TOKENS = 4096;

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export interface AgentReply {
  text: string;
  /** Path to a backup file to attach, when export_backup was called this turn. */
  attachment?: string;
}

export async function respond(userText: string): Promise<AgentReply> {
  const messages: Anthropic.MessageParam[] = [
    ...recentTurns(HISTORY_TURNS).map(
      (turn): Anthropic.MessageParam => ({
        role: turn.role,
        content: turn.content,
      }),
    ),
    { role: "user", content: userText },
  ];

  // Built once per response so overdue reminders are consistent across the
  // whole tool-use loop rather than shifting between rounds.
  const system = buildSystemPrompt();
  let reply = "";
  let attachment: string | undefined;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: TOOLS,
      // Sonnet 5 runs adaptive thinking by default; disabling it makes the
      // model markedly less willing to reach for tools, which would be fatal
      // here. Effort is the latency dial instead.
      thinking: { type: "adaptive" },
      output_config: { effort: config.effort },
    });

    if (response.stop_reason === "refusal") {
      return { text: "That one tripped a safety filter on my end. Try rephrasing?" };
    }

    reply = textOf(response);

    if (response.stop_reason !== "tool_use") break;

    if (round === MAX_TOOL_ROUNDS) {
      reply ||= "I got stuck in a loop working that out. Try asking a smaller piece of it?";
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    // All results for one assistant turn go back in a single user message.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        const result = await runTool(block.name, block.input);
        if (
          block.name === "export_backup" &&
          typeof result === "object" &&
          result !== null &&
          "path" in result
        ) {
          attachment = String((result as { path: unknown }).path);
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (error) {
        const message =
          error instanceof ToolError || error instanceof Error
            ? error.message
            : String(error);
        if (!(error instanceof ToolError)) {
          console.error(`[tool:${block.name}]`, error);
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: message }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  if (!reply) reply = "Nothing to say to that, apparently. Try again?";

  appendTurn("user", userText);
  appendTurn("assistant", reply);
  return { text: reply, attachment };
}
