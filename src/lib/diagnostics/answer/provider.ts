/**
 * AI Diagnostics — the PROVIDER CALL (AID-7, #2378; owner decision Q1, 11 Aug 2026).
 *
 * The second of exactly two modules in this codebase that import `@anthropic-ai/sdk`;
 * `src/lib/anthropic-client.ts` is the other, and it serves page help. The split is
 * deliberate rather than duplication: page help has NO tools, a 512-token answer and a
 * frozen prompt that promises "you have no tools, no actions, and no access to any
 * account, booking, or database". Diagnostics is an agentic tool loop with a budget
 * reservation per round. Folding the second into the first would mean one module whose
 * system prompt has to be true of both, and the page-help prompt's central promise is
 * the thing diagnostics exists to break.
 *
 * BOTH IMPORTERS ARE PINNED BY A DERIVED CENSUS —
 * `src/lib/__tests__/anthropic-sdk-importers.test.ts` reads the tree and asserts the
 * set. It is derived rather than hand-listed because the claim it replaces ("the ONLY
 * module in the codebase that imports the SDK") was TRUE, load-bearing, and enforced by
 * nothing, so this file falsified it silently the moment it was written. That is the
 * failure mode this repository keeps producing, and a census is the only version of the
 * claim that cannot drift.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide what the model may see, does not
 * meter, does not gate and does not loop. It sends a request and classifies what comes
 * back. Every control lives in the caller (`loop.ts`) and in the substrate
 * (`tools/invoke.ts`), so a change here cannot widen anybody's access.
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { AiUsage } from "@/lib/anthropic-client";

import type { DiagnosticsToolProviderDefinition } from "../tools/definitions";
import { DIAGNOSTICS_SYSTEM_PROMPT } from "./prompt";

/**
 * Sonnet 5 (owner decision Q1, 11 Aug 2026): sufficient for code-plus-tools
 * investigation at roughly a third of Opus's cost, with the monthly budget as the real
 * cap. The decision comment records that switching later is "configuration/code, not a
 * reason to leave this issue undecided" — so it is one constant, here.
 */
export const DIAGNOSTICS_MODEL = "claude-sonnet-5";

/**
 * Output ceiling for one round. Larger than page help's 512 because a diagnostics
 * answer carries several blocker codes plus their provenance, and a truncated final
 * answer is the one output an operator cannot act on. It stays well under the
 * per-roundtrip ceiling the budget maths assumes
 * (`DIAGNOSTICS_MAX_OUTPUT_TOKENS_PER_ROUNDTRIP`).
 */
export const DIAGNOSTICS_MAX_TOKENS = 2_048;

/**
 * Per-request wall-clock ceiling. Longer than page help's 20 s because a tool round
 * may sit behind a database read that #2804 allows to wait ~15 s for a connection —
 * but it bounds ONE provider call, not the loop; `loop.ts` owns the loop's own
 * deadline.
 */
export const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 60_000;

/**
 * NO SDK-LEVEL RETRY, unlike page help's one.
 *
 * A diagnostics round reserves budget BEFORE it is sent and settles on what came back.
 * A retry inside the SDK is a second paid call the reservation never saw and the
 * settlement cannot attribute, so the meter would under-count exactly the calls that
 * were struggling. The loop refuses and reports instead, which is also the honest
 * answer for an operator: a diagnostics question that failed halfway is not one to
 * silently re-run against a busy database.
 */
export const DIAGNOSTICS_MAX_RETRIES = 0;

export type DiagnosticsProviderErrorCode =
  | "auth"
  | "rate_limited"
  | "overloaded"
  | "invalid_request"
  | "timeout"
  | "refusal"
  | "unknown";

/** One tool the model asked to run. `input` is UNTRUSTED and is parsed downstream. */
export interface DiagnosticsProviderToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface DiagnosticsProviderResponse {
  ok: true;
  /** Text the model produced this round. May be empty on a pure tool-use round. */
  text: string;
  /** The tools it asked for, in order. Empty when it is answering. */
  toolUses: DiagnosticsProviderToolUse[];
  /** True when the model stopped because it hit the output ceiling. */
  truncated: boolean;
  /** True when the model stopped to run tools. */
  wantsTools: boolean;
  usage: AiUsage;
  /**
   * The assistant content EXACTLY as the provider returned it, to be replayed as the
   * assistant turn of the next round.
   *
   * REPLAYING THIS IN THE `assistant` ROLE IS CORRECT, and it is the one place in
   * diagnostics where that is true — which is worth stating beside `prompt.ts`, whose
   * whole job is to refuse to do it. The distinction is provenance, not role: these
   * blocks were produced by the provider inside THIS request and have been held by the
   * server ever since. They never went to a browser and never came back. The turns
   * `prompt.ts` refuses to replay as `assistant` are the ones a client POSTed.
   */
  assistantContent: Anthropic.ContentBlockParam[];
}

export type DiagnosticsProviderResult =
  | DiagnosticsProviderResponse
  | { ok: false; code: DiagnosticsProviderErrorCode; usage?: AiUsage };

function mapUsage(usage: Anthropic.Usage | undefined): AiUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

/** Dig the API error `type` out of the SDK's error body (shape varies). */
function apiErrorType(
  err: InstanceType<typeof Anthropic.APIError>,
): string | undefined {
  const body = err.error as
    | { type?: string; error?: { type?: string } }
    | undefined;
  return body?.error?.type ?? body?.type;
}

/**
 * Classify a thrown provider error. Deliberately the same taxonomy and the same
 * subclass ORDER as `anthropic-client.ts` — `APIConnectionError` is a subclass of
 * `APIError` in the TS SDK and must be tested first, which is the kind of detail that
 * goes wrong when two copies drift.
 */
function classifyError(err: unknown): DiagnosticsProviderErrorCode {
  if (err instanceof Anthropic.AuthenticationError) return "auth";
  if (err instanceof Anthropic.RateLimitError) return "rate_limited";
  if (err instanceof Anthropic.APIConnectionError) return "timeout";
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 529 || apiErrorType(err) === "overloaded_error") {
      return "overloaded";
    }
    if (typeof status === "number") {
      if (status >= 500) return "unknown";
      if (status >= 400) return "invalid_request";
    }
    return "unknown";
  }
  return "unknown";
}

export interface RunDiagnosticsProviderRoundInput {
  apiKey: string;
  /**
   * The conversation for THIS question, built by `loop.ts`. The first entry is the
   * operator's wrapped question and its evidence blocks; later entries alternate the
   * provider's own assistant content and the tool results it asked for.
   */
  messages: Anthropic.MessageParam[];
  /**
   * The tools this caller may be offered, from `listDiagnosticsToolDefinitions` —
   * already filtered by their freshly-read permission matrix AND this request's
   * consent. Passed through untouched: this module must not add, rename or widen one.
   */
  tools: DiagnosticsToolProviderDefinition[];
}

/**
 * Run ONE provider round.
 *
 * It never throws: every fault becomes a typed `{ok: false, code}` so the loop can
 * settle the budget it already reserved. A round that threw past the caller would leave
 * a reservation outstanding, which is the one accounting outcome the metering contract
 * is written to prevent.
 */
export async function runDiagnosticsProviderRound(
  input: RunDiagnosticsProviderRoundInput,
): Promise<DiagnosticsProviderResult> {
  const client = new Anthropic({
    apiKey: input.apiKey,
    timeout: DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    maxRetries: DIAGNOSTICS_MAX_RETRIES,
  });

  try {
    // No retention instruction is sent: retention is arranged between the club
    // and Anthropic on the account behind the Diagnostics key (#5243).
    const response = await client.messages.create({
      model: DIAGNOSTICS_MODEL,
      max_tokens: DIAGNOSTICS_MAX_TOKENS,
      // ONE system block, and it is the frozen constant. Page help adds a second
      // cache-marked block for its grounding corpus; diagnostics has no equivalent
      // trusted corpus to cache — its evidence is gathered per question and belongs in
      // the user turn, which is exactly what keeps it out of the authority role.
      system: [{ type: "text", text: DIAGNOSTICS_SYSTEM_PROMPT }],
      messages: input.messages,
      ...(input.tools.length > 0
        ? {
            // REBUILT FIELD BY FIELD, not cast. `DiagnosticsToolInputSchema` is a
            // closed four-field interface and the SDK's `InputSchema` carries an index
            // signature, so the two are not mutually assignable — and the tempting fix
            // (`as unknown as Anthropic.Tool[]`) would silence exactly the error that
            // would tell us the registry's schema shape had changed. Naming the fields
            // means a registry entry that grows a field fails to compile here, which is
            // where somebody should be deciding whether the provider may see it.
            tools: input.tools.map(
              (tool): Anthropic.Tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: {
                  type: "object",
                  properties: tool.input_schema.properties,
                  ...(tool.input_schema.required
                    ? { required: tool.input_schema.required }
                    : {}),
                  additionalProperties: tool.input_schema.additionalProperties,
                },
              }),
            ),
          }
        : {}),
    });

    const usage = mapUsage(response.usage);

    // A refusal is reported as its own code rather than as an empty answer: the
    // operator is owed the difference between "the model declined" and "the model had
    // nothing to say", and the usage is still settled either way.
    if (response.stop_reason === "refusal") {
      return { ok: false, code: "refusal", usage };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const toolUses = response.content
      .filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      )
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input as unknown,
      }));

    return {
      ok: true,
      text,
      toolUses,
      truncated: response.stop_reason === "max_tokens",
      // Derived from the CONTENT rather than from `stop_reason === "tool_use"`. The two
      // agree today, but the loop must feed a `tool_result` for every `tool_use` block
      // the provider returned or the next request is rejected, so the thing to branch on
      // is whether any such block exists.
      wantsTools: toolUses.length > 0,
      usage,
      assistantContent: response.content as Anthropic.ContentBlockParam[],
    };
  } catch (err) {
    return { ok: false, code: classifyError(err) };
  }
}
