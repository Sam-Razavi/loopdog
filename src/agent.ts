import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { appendTurn, recentTurns } from "./db/history";
import type { SupportedImageType } from "./imagetype";
import { buildSystemPrompt } from "./prompt";
import { buildTools, runTool, ToolError } from "./tools";

export type { SupportedImageType };

const MAX_TOOL_ROUNDS = 6;
const HISTORY_TURNS = 20;
const MAX_TOKENS = 4096;

/**
 * Sonnet 5 rates, USD per million tokens. Cache writes bill at 1.25x input
 * (5-minute TTL, the one used here), cache reads at 0.1x. Only used for the
 * log line below — nothing branches on it, so a stale rate misreports a
 * number in the logs but can never change behaviour.
 */
const RATE_IN = 2 / 1_000_000;
const RATE_OUT = 10 / 1_000_000;

interface UsageTotals {
  rounds: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * One line per reply, so "why is this expensive" is arithmetic instead of
 * guesswork, and so the prompt cache is self-verifying: on any message that
 * takes more than one round, cache_read should dominate from round 2 on. If
 * it stays at 0, something is invalidating the prefix (see buildSystemPrompt).
 */
function logUsage(t: UsageTotals): void {
  const cost =
    t.input * RATE_IN + t.cacheWrite * RATE_IN * 1.25 + t.cacheRead * RATE_IN * 0.1 + t.output * RATE_OUT;
  console.log(
    `[usage] rounds=${t.rounds} in=${t.input} cache_write=${t.cacheWrite} ` +
      `cache_read=${t.cacheRead} out=${t.output} ~$${cost.toFixed(4)}`,
  );
}

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Built once: the tool list is the first thing in the prompt-cache prefix, so it
// must be byte-identical across calls or every request would miss the cache.
const TOOLS = buildTools();

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export interface ImageInput {
  mediaType: SupportedImageType;
  data: string; // base64
}

export interface AgentReply {
  text: string;
  /**
   * Paths to files to attach, when tools like export_backup/habit_chart ran
   * this turn. A list, not a single slot: two chart calls in one turn used to
   * overwrite each other, so the first file was never sent and leaked in the
   * temp directory.
   */
  attachments: string[];
}

// Tools whose result includes a "path" the caller should attach to the reply.
const ATTACHMENT_TOOLS = new Set(["export_backup", "habit_chart", "metric_chart"]);

/**
 * Serialises every call, because the Discord handler is fully re-entrant:
 * two messages arriving close together would each read the same
 * recentTurns() and each appendTurn() at the end, landing history as
 * user1, user2, assistant2, assistant1 — and the second message would never
 * see the first's context. Queueing here rather than in index.ts means
 * repl.ts and any future caller get the same guarantee for free.
 *
 * The tail .catch keeps one rejected turn from wedging the chain forever;
 * the rejection still reaches that call's own awaiter.
 */
let queue: Promise<unknown> = Promise.resolve();

export function respond(userText: string, images: ImageInput[] = []): Promise<AgentReply> {
  const result = queue.then(() => respondInner(userText, images));
  queue = result.catch(() => undefined);
  return result;
}

async function respondInner(userText: string, images: ImageInput[] = []): Promise<AgentReply> {
  const userContent: Anthropic.MessageParam["content"] = images.length
    ? [
        { type: "text", text: userText },
        ...images.map(
          (image): Anthropic.ImageBlockParam => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          }),
        ),
      ]
    : userText;

  const messages: Anthropic.MessageParam[] = [
    ...recentTurns(HISTORY_TURNS).map(
      (turn): Anthropic.MessageParam => ({
        role: turn.role,
        content: turn.content,
      }),
    ),
    { role: "user", content: userContent },
  ];

  // Built once per response so overdue reminders are consistent across the
  // whole tool-use loop rather than shifting between rounds.
  const system = buildSystemPrompt();
  let reply = "";
  const attachments: string[] = [];
  const usage: UsageTotals = { rounds: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

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
      // Explicit breakpoint in buildSystemPrompt() pins tools + static system
      // (the expensive shared prefix); this auto-caches the growing tail so
      // rounds 2+ of a tool loop re-read it instead of re-paying for it.
      cache_control: { type: "ephemeral" },
    });

    usage.rounds += 1;
    usage.input += response.usage.input_tokens;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.output += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      logUsage(usage);
      return {
        text: "That one tripped a safety filter on my end. Try rephrasing?",
        attachments,
      };
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
          ATTACHMENT_TOOLS.has(block.name) &&
          typeof result === "object" &&
          result !== null &&
          "path" in result
        ) {
          attachments.push(String((result as { path: unknown }).path));
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

  logUsage(usage);

  if (!reply) reply = "Nothing to say to that, apparently. Try again?";

  // Persist only text — an attached image's bytes never enter history, so a
  // years-long conversation never re-sends old image data on every future
  // turn. A short marker keeps the fact that one was shared, for context.
  const persistedText = images.length
    ? `${userText} [${images.length} image${images.length === 1 ? "" : "s"} attached]`
    : userText;
  appendTurn("user", persistedText);
  appendTurn("assistant", reply);
  return { text: reply, attachments };
}
