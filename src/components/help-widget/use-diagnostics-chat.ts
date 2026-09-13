"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DIAGNOSTICS_WIRE_BOUNDS,
  type DiagnosticsAskProvenance,
  type DiagnosticsAskRequest,
  type DiagnosticsAskResponse,
  type DiagnosticsAskTurn,
} from "@/lib/diagnostics/answer/contract";

/**
 * The Diagnostics conversation, held in memory for as long as the tab is open
 * (AID-7, #2378; owner decision Q5).
 *
 * NOTHING HERE IS PERSISTED, and that is the decision rather than an omission. There
 * is no `localStorage`, no cookie and no server-side transcript: a reload loses the
 * conversation, which #2378 accepts in as many words — "a page reload/new investigation
 * may lose in-memory conversation history; do not silently introduce persistence to
 * avoid that UX cost." The panel SIZE is remembered per browser; the conversation is
 * not, and the difference is that one of them is evidence about people.
 *
 * THE TWO TICKS RESET AFTER EVERY QUESTION (owner decision D9, 12 Aug 2026). This is
 * the single most load-bearing line in the file, so it is stated plainly: the server
 * grants both permissions PER REQUEST, and a tick that stayed on would be the UI
 * claiming an authority the gate does not give it. The friction of re-ticking is the
 * decision, not a side effect of it — and it is also honest, because the operator
 * really is granting it again.
 */

export type DiagnosticsMessageRole = "operator" | "assistant";

export interface DiagnosticsMessage {
  id: string;
  role: DiagnosticsMessageRole;
  text: string;
  /** The provenance of an answer (owner decision D10). Absent on operator turns. */
  provenance?: DiagnosticsAskProvenance;
  /** Set when the answer was shortened by the model's output ceiling. */
  truncated?: boolean;
  /**
   * Set on a refusal bubble. It is kept OUT of the transcript that is replayed to the
   * server, for the same reason page help drops its transient bubbles: "diagnostics is
   * over budget" is a fact about the deployment, not part of the investigation, and
   * replaying it invites the model to reason about its own plumbing.
   */
  blocked?: boolean;
  /**
   * The screen this turn was asked from. Client-side only, and never sent: it exists
   * so the panel can tell the operator that the conversation began somewhere else.
   * The SERVER re-derives the page context from the CURRENT pathname on every request,
   * so nothing about evidence depends on this value.
   */
  pathname?: string;
}

/** How long a question may run before the panel says it is still working (ms). */
export const DIAGNOSTICS_STILL_WORKING_AFTER_MS = 4_000;

/** Prior turns replayed. Mirrors the route's own zod bound; never over-send. */
// The wire bounds come from the contract module — the one place both ends import —
// never restated here. See DIAGNOSTICS_WIRE_BOUNDS's docblock for the drift this
// replaced.
const MAX_SENT_TURNS = DIAGNOSTICS_WIRE_BOUNDS.maxReplayedTurns;
const TURN_MAX_CHARS = DIAGNOSTICS_WIRE_BOUNDS.turnMaxChars;

export interface DiagnosticsAskOptions {
  pathname: string;
  /**
   * The record the page registered as open, when the address does not name one.
   * A SELECTOR: the server picks the kind from the route and re-resolves the record
   * under the operator's own authority before reading a field.
   */
  recordId?: string;
  /**
   * The contract's own shape, not a loose `Record<string, string>` — the loose type
   * was assignable to the request while letting `{ filters: "oops" }` compile, which
   * defeated the "compiler catches the disagreement" property this hook claims
   * (correctness review, 13 Aug 2026).
   *
   * #2816 wires it, and the URL-at-ask-time design this comment used to describe
   * was SUPERSEDED by the owner decision of 13 Aug 2026: the primary channel is the
   * page's own PUBLISHED APPLIED state (`usePublishDiagnosticsViewState`), read by
   * `DiagnosticsView` from the help-widget context. Reading the address is the
   * FALLBACK, for pages nobody has wired. (The earlier note also called these list
   * pages server components; three of the four — payments, members, waitlist — are
   * client components, and their applied state never reaches a query string at all
   * until their own sync effect commits.) Either way the value is sent raw and the
   * route narrows it to the matched registry row's allowlists, which
   * `parseDiagnosticsPageSelector` then re-validates.
   */
  view?: DiagnosticsAskRequest["view"];
}

export interface UseDiagnosticsChat {
  messages: DiagnosticsMessage[];
  ask: (question: string, options: DiagnosticsAskOptions) => Promise<void>;
  reset: () => void;
  pending: boolean;
  /** Milliseconds the in-flight question has been running. 0 when idle. */
  elapsedMs: number;
  /** The two per-question ticks, and their setters. Both reset after every send. */
  allowPeopleSearch: boolean;
  setAllowPeopleSearch: (value: boolean) => void;
  allowRecordPersonalDetails: boolean;
  setAllowRecordPersonalDetails: (value: boolean) => void;
  /** Set once the monthly budget is reported spent — the input stays disabled. */
  budgetExhausted: boolean;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `diagnostics-msg-${idCounter}`;
}

/**
 * The transcript to replay: settled operator→assistant pairs only.
 *
 * A refusal bubble and its question are BOTH dropped, so the model never sees a turn
 * whose answer was "the budget is spent". A trailing unanswered question is dropped
 * too. The cap is applied to the filtered pairs and `MAX_SENT_TURNS` is even, so
 * slicing can never split a pair and leave the model an answer with no question.
 */
function buildTranscript(messages: DiagnosticsMessage[]): DiagnosticsAskTurn[] {
  const turns: DiagnosticsAskTurn[] = [];
  // `.entries()` hands back each `question` already typed as a real message
  // (never possibly-undefined the way `messages[index]` would read), so only
  // the deliberate one-ahead lookahead (`messages[index + 1]`, already
  // guarded below) still indexes. The former `index += 1` skip-ahead after a
  // consumed answer is not needed for correctness: the next iteration's
  // `question.role !== "operator"` check already rejects that same message
  // when it is reached as a would-be question, for the identical result.
  for (const [index, question] of messages.entries()) {
    if (question.role !== "operator") continue;
    const answer = messages[index + 1];
    if (!answer || answer.role !== "assistant") continue;
    if (answer.blocked) continue;
    const questionText = question.text.slice(0, TURN_MAX_CHARS);
    const answerText = answer.text.slice(0, TURN_MAX_CHARS);
    if (!questionText || !answerText) continue;
    turns.push(
      { role: "operator", text: questionText },
      { role: "assistant", text: answerText },
    );
  }
  return turns.slice(-MAX_SENT_TURNS);
}

/** The sentence shown when the transport itself failed, so no server copy exists. */
export const DIAGNOSTICS_NETWORK_FAILURE_COPY =
  "That question could not be sent. Check your connection and try again — you do not need to reload the page.";

/** The sentence shown when the module is off, which the route answers with a 404. */
export const DIAGNOSTICS_UNAVAILABLE_COPY =
  "AI Diagnostics is not switched on for this club, so it cannot answer questions.";

/**
 * The per-admin limiter's own sentence (15 questions / 10 minutes — the refusal an
 * operator working a batch of stuck bookings actually hits). The correctness review
 * (13 Aug 2026) found the first cut collapsing the 429 into the network-failure copy
 * above — "check your connection" to a throttled operator whose connection is fine,
 * inviting exactly the retry storm the limiter exists to stop. The wording follows
 * `DIAGNOSTICS_ASK_BLOCKED_COPY.rate_limited`, which only the rarer global backstop
 * emits as a structured reply; a 429 arrives as a plain rate-limit response with no
 * diagnostics body, so the client owns this one sentence.
 */
export const DIAGNOSTICS_RATE_LIMITED_COPY =
  "That is a lot of questions in a short time. Wait a minute or two and ask again — you do not need to reload the page.";

/** Session expired or access revoked mid-conversation: a 401/403 is not a transport fault. */
export const DIAGNOSTICS_SESSION_FAILURE_COPY =
  "Your session no longer allows this — it may have expired, or your access may have changed. Sign in again to keep asking.";

export function useDiagnosticsChat(): UseDiagnosticsChat {
  const [messages, setMessages] = useState<DiagnosticsMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [allowPeopleSearch, setAllowPeopleSearch] = useState(false);
  const [allowRecordPersonalDetails, setAllowRecordPersonalDetails] =
    useState(false);
  const [budgetExhausted, setBudgetExhausted] = useState(false);
  const pendingRef = useRef(false);

  /**
   * The elapsed clock behind the "still working" state (#2804, owner decision 12 Aug
   * 2026). It exists because a diagnostics read may legitimately wait ~15 s for a busy
   * database, and the owner accepted that on one binding condition: "the longer wait
   * must not reach a user-facing screen without a progress state."
   *
   * It ticks once a second — fast enough to feel alive, slow enough that the polite
   * live region is not re-announcing constantly, which is the accessibility failure
   * this issue explicitly names ("live/status announcements that do not turn
   * streaming/status noise into an accessibility problem").
   */
  useEffect(() => {
    if (!pending) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, [pending]);

  const append = useCallback((message: Omit<DiagnosticsMessage, "id">) => {
    setMessages((prev) => [...prev, { id: nextId(), ...message }]);
  }, []);

  const ask = useCallback(
    async (question: string, options: DiagnosticsAskOptions) => {
      const trimmed = question.trim();
      if (!trimmed || pendingRef.current || budgetExhausted) return;

      // The ticks are captured for THIS request before anything can change them, and
      // cleared below whatever the outcome. Reading them off state inside the response
      // handler would re-read whatever the operator had toggled while waiting.
      const askedWithPeopleSearch = allowPeopleSearch;
      const askedWithPersonalDetails = allowRecordPersonalDetails;

      const transcript = buildTranscript(messages);
      append({
        role: "operator",
        text: trimmed,
        pathname: options.pathname,
      });
      pendingRef.current = true;
      setPending(true);

      try {
        // Typed as the contract's own request shape, so this literal is the
        // place the compiler catches the client and the route disagreeing —
        // an untyped body here would make `contract.ts` documentation only.
        const askBody: DiagnosticsAskRequest = {
          pathname: options.pathname,
          question: trimmed,
          transcript,
          allowPeopleSearch: askedWithPeopleSearch,
          allowRecordPersonalDetails: askedWithPersonalDetails,
          ...(options.recordId ? { recordId: options.recordId } : {}),
          ...(options.view ? { view: options.view } : {}),
        };
        const response = await fetch("/api/admin/ai-diagnostics/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(askBody),
        });

        // The module gate answers with a frozen 404, byte-identical to a route that
        // does not exist — deliberately, so an anonymous probe cannot read the club's
        // module state off the reply. For an ADMIN who just used the Diagnostics tab
        // it can only mean the module was switched off, so that is what is said.
        if (response.status === 404) {
          append({
            role: "assistant",
            text: DIAGNOSTICS_UNAVAILABLE_COPY,
            blocked: true,
          });
          return;
        }

        // STATUS BEFORE BODY, and each refusal gets its own sentence. #2378 requires
        // failure states to be first-class UX, and the two most reachable non-ok
        // statuses in normal use are precisely the ones a "check your connection"
        // collapse misdiagnoses: a 429 (the per-admin limiter) and a 401/403 (the
        // session expired, or access changed mid-conversation).
        if (response.status === 429) {
          append({
            role: "assistant",
            text: DIAGNOSTICS_RATE_LIMITED_COPY,
            blocked: true,
          });
          return;
        }
        if (response.status === 401 || response.status === 403) {
          append({
            role: "assistant",
            text: DIAGNOSTICS_SESSION_FAILURE_COPY,
            blocked: true,
          });
          return;
        }

        const data = (await response
          .json()
          .catch(() => null)) as DiagnosticsAskResponse | null;

        if (!response.ok || !data) {
          append({
            role: "assistant",
            text: DIAGNOSTICS_NETWORK_FAILURE_COPY,
            blocked: true,
          });
          return;
        }

        if (data.status === "blocked") {
          if (data.reason === "budget_exhausted") setBudgetExhausted(true);
          // The server owns every one of these sentences (see
          // DIAGNOSTICS_ASK_BLOCKED_COPY). The client renders them and adds nothing:
          // a second copy of this wording here is the one that drifts.
          append({
            role: "assistant",
            text: data.nextStep ? `${data.message} ${data.nextStep}` : data.message,
            blocked: true,
            ...(data.provenance ? { provenance: data.provenance } : {}),
          });
          return;
        }

        append({
          role: "assistant",
          text: data.answer,
          provenance: data.provenance,
          truncated: data.truncated,
        });
      } catch {
        append({
          role: "assistant",
          text: DIAGNOSTICS_NETWORK_FAILURE_COPY,
          blocked: true,
        });
      } finally {
        pendingRef.current = false;
        setPending(false);
        // BOTH TICKS RESET, on every path including a failure (owner decision D9).
        // Leaving them set after a refusal would be the worst version: the operator
        // retries, and a permission they granted for a question that never ran is
        // silently reused for the next one.
        setAllowPeopleSearch(false);
        setAllowRecordPersonalDetails(false);
      }
    },
    [
      allowPeopleSearch,
      allowRecordPersonalDetails,
      append,
      budgetExhausted,
      messages,
    ],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setBudgetExhausted(false);
    setAllowPeopleSearch(false);
    setAllowRecordPersonalDetails(false);
  }, []);

  return {
    messages,
    ask,
    reset,
    pending,
    elapsedMs,
    allowPeopleSearch,
    setAllowPeopleSearch,
    allowRecordPersonalDetails,
    setAllowRecordPersonalDetails,
    budgetExhausted,
  };
}
