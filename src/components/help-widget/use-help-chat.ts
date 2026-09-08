"use client";

import { useCallback, useRef, useState } from "react";
import { type HelpQuestion } from "@/lib/contextual-help/types";

/**
 * Help-widget conversation state. Two ways to add a turn:
 *  - `askCurated(question)` — appends the question and its distilled answer
 *    instantly from the trusted corpus. This path always works, LLM on or off.
 *  - `sendFreeText(text, meta)` — the paid AI path (epic #2094 C4). It POSTs to
 *    the typed `chatEndpoint` (/api/help/chat) with the page + surface + a capped
 *    transcript + serialized page context, and reconciles the structured
 *    response contract:
 *      { status: "answered", answer, truncated, remainingExchanges }
 *      { status: "fallback", reason }
 *      429 / 4xx / 5xx / network error.
 *    The guard below returns before any fetch when `llmEnabled` is false or no
 *    `chatEndpoint` is supplied, so the branch is inert on the public surface.
 */

export type HelpChatRole = "user" | "assistant";

export type HelpChatMessage = {
  id: string;
  role: HelpChatRole;
  text: string;
  /** Set on answers that came verbatim from the templated corpus. */
  fromGuide?: boolean;
  /** Assistant-style fallback / error bubbles — excluded from the sent transcript. */
  transient?: boolean;
  /** The provider truncated this answer (max_tokens); a note renders below it. */
  truncated?: boolean;
  link?: { href: string; label: string };
};

/** Prior turns are capped to the last 8 entries before they are POSTed. */
export const MAX_SENT_TRANSCRIPT = 8;
/** Per-turn character cap mirroring the route's zod bound (never over-send). */
const TURN_MAX_CHARS = 2000;

// Assistant-style copy. The transient reasons keep the input enabled; only
// budget exhaustion disables it for the session.
export const FALLBACK_ANSWER =
  "Sorry — I could not answer that just now. Try the Page guide tab, or contact the club office.";
export const BUDGET_EXHAUSTED_COPY =
  "The AI assistant has reached this month's spending limit, so it can't answer more questions right now. Try the Page guide tab, or contact the club office.";
export const RATE_LIMITED_COPY = "Please wait a bit and try again.";
export const TRUNCATED_NOTE =
  "That answer was shortened. Ask a follow-up if you need the rest.";

export type HelpChatSurface = "member" | "admin" | "finance";

export type SendFreeTextMeta = {
  pathname: string;
  surface: HelpChatSurface;
  /** Serialized registered page extras (already capped under the zod 4000). */
  pageContext?: string;
};

/** Why the free-text input is disabled for the rest of this session, if at all. */
export type ChatDisabledReason = "budget";

export type UseHelpChatOptions = {
  llmEnabled: boolean;
  /** Typed fetch target for the free-text path; supplied by C4, never here. */
  chatEndpoint?: string;
};

export type UseHelpChat = {
  messages: HelpChatMessage[];
  askCurated: (question: HelpQuestion) => void;
  sendFreeText: (text: string, meta: SendFreeTextMeta) => Promise<void>;
  reset: () => void;
  pending: boolean;
  /** The AI exchange limit for this conversation has been reached. */
  capReached: boolean;
  /** Set once the provider reports the monthly budget is exhausted. */
  disabledReason: ChatDisabledReason | null;
};

type ChatResponse = {
  status?: unknown;
  answer?: unknown;
  truncated?: unknown;
  remainingExchanges?: unknown;
  reason?: unknown;
};

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `help-msg-${idCounter}`;
}

/**
 * Build the alternating transcript POSTed alongside the new question.
 *
 * Only *settled* user→assistant pairs are sent, and curated (`fromGuide`)
 * exchanges are excluded, because:
 *  (a) the server's grounding block already contains every curated Q&A pair
 *      (C1's `buildHelpGrounding` serializes them), so resending a curated
 *      exchange duplicates tokens for zero grounding value and needlessly eats
 *      into the last-8 cap; and
 *  (b) pair-dropping keeps the transcript clean of failed questions. A user
 *      turn whose only following assistant bubble is transient (a fallback /
 *      error) — or a trailing user turn with no answer yet — is dropped. The
 *      current Anthropic API merges consecutive same-role turns rather than
 *      erroring, so this is hygiene + cost, not a crash fix.
 *
 * The per-turn char cap and the last-8 cap then operate on the filtered pairs;
 * MAX_SENT_TRANSCRIPT is even, so slicing never splits a pair.
 */
function buildTranscript(
  messages: HelpChatMessage[],
): Array<{ role: HelpChatRole; content: string }> {
  const turns: Array<{ role: HelpChatRole; content: string }> = [];
  // `.entries()` types `user` as a real message directly (never
  // possibly-undefined the way `messages[i]` would read); only the
  // deliberate one-ahead lookahead still indexes, and it is already guarded
  // below. The former `i += 1` skip-ahead after a consumed answer is not
  // needed for correctness: the next iteration's `user.role !== "user"`
  // check already rejects that same message when it is reached as a
  // would-be user turn, for the identical result.
  for (const [i, user] of messages.entries()) {
    if (user.role !== "user") continue;
    const answer = messages[i + 1];
    // Unpaired trailing user turn (no answer settled yet) — drop it.
    if (!answer || answer.role !== "assistant") continue;
    // Curated exchanges live in the grounding block; transient bubbles mark a
    // failed exchange. Either way, do not resend the pair.
    if (answer.fromGuide || answer.transient) continue;
    const userContent = user.text.slice(0, TURN_MAX_CHARS);
    const answerContent = answer.text.slice(0, TURN_MAX_CHARS);
    if (!userContent || !answerContent) continue;
    turns.push(
      { role: "user", content: userContent },
      { role: "assistant", content: answerContent },
    );
  }
  return turns.slice(-MAX_SENT_TRANSCRIPT);
}

export function useHelpChat({
  llmEnabled,
  chatEndpoint,
}: UseHelpChatOptions): UseHelpChat {
  const [messages, setMessages] = useState<HelpChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  // null until the first answered response reports how many exchanges remain.
  const [remainingExchanges, setRemainingExchanges] = useState<number | null>(
    null,
  );
  const [disabledReason, setDisabledReason] =
    useState<ChatDisabledReason | null>(null);
  const pendingRef = useRef(false);

  const capReached = remainingExchanges !== null && remainingExchanges <= 0;

  const appendAssistant = useCallback(
    (text: string, extra?: Partial<HelpChatMessage>) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", text, ...extra },
      ]);
    },
    [],
  );

  const askCurated = useCallback((question: HelpQuestion) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: question.q },
      {
        id: nextId(),
        role: "assistant",
        text: question.a,
        fromGuide: true,
        link: question.link,
      },
    ]);
  }, []);

  const sendFreeText = useCallback(
    async (text: string, meta: SendFreeTextMeta) => {
      // Inert while the input is not rendered and no endpoint is configured.
      if (!llmEnabled || !chatEndpoint) {
        return;
      }
      const trimmed = text.trim();
      if (
        !trimmed ||
        capReached ||
        disabledReason !== null ||
        pendingRef.current
      ) {
        return;
      }
      // The wire cap; the optimistic bubble shows exactly what is sent.
      const question = trimmed.slice(0, 1000);

      // Snapshot the transcript BEFORE the new user turn — the new question
      // travels in `question`, never inside the transcript.
      const transcript = buildTranscript(messages);

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: question },
      ]);
      pendingRef.current = true;
      setPending(true);

      try {
        const response = await fetch(chatEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pathname: meta.pathname,
            surface: meta.surface,
            question,
            transcript,
            ...(meta.pageContext ? { pageContext: meta.pageContext } : {}),
          }),
        });

        if (response.status === 429) {
          appendAssistant(RATE_LIMITED_COPY, { transient: true });
          return;
        }

        const data = (await response
          .json()
          .catch(() => null)) as ChatResponse | null;

        if (!response.ok || !data) {
          appendAssistant(FALLBACK_ANSWER, { transient: true });
          return;
        }

        if (data.status === "fallback") {
          if (data.reason === "budget_exhausted") {
            setDisabledReason("budget");
            appendAssistant(BUDGET_EXHAUSTED_COPY, { transient: true });
            return;
          }
          appendAssistant(FALLBACK_ANSWER, { transient: true });
          return;
        }

        if (data.status === "answered" && typeof data.answer === "string") {
          const truncated = data.truncated === true;
          appendAssistant(data.answer, { truncated });
          if (typeof data.remainingExchanges === "number") {
            setRemainingExchanges(data.remainingExchanges);
          }
          return;
        }

        appendAssistant(FALLBACK_ANSWER, { transient: true });
      } catch {
        appendAssistant(FALLBACK_ANSWER, { transient: true });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [llmEnabled, chatEndpoint, capReached, disabledReason, messages, appendAssistant],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setRemainingExchanges(null);
    setDisabledReason(null);
  }, []);

  return {
    messages,
    askCurated,
    sendFreeText,
    reset,
    pending,
    capReached,
    disabledReason,
  };
}
