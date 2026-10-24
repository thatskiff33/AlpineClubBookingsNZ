import { CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE } from "@/lib/xero-credit-note-spent-outside-app";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { XERO_ORPHANED_STALE_RUNNING_ERROR_CODE } from "@/lib/xero-operation-error-codes";

/**
 * #4278: WHY a Xero sync operation failed, in words an officer who does not read
 * code can act on. `xero-operation-summaries.ts` (#1448) already says what an
 * operation WAS; this says why it did not work and what to do next.
 *
 * ONE FUNCTION, ONE TABLE. The operations panel, the Xero activity panel and the
 * booking page's invoice warning all call `explainXeroFailure`, so the three
 * surfaces can never describe one row differently. It is display only: nothing
 * here records, retries, classifies or resolves a failure.
 *
 * IT NEVER ADDS A VALUE THE RAW VIEW WOULD HIDE. The input is the stored
 * `lastErrorMessage`, which `failXeroSyncOperation` has already put through
 * `redactSensitiveText`. Every known cause is a FIXED English template: the only
 * values it fills in are a noun for the record type and a rounded wait derived
 * from a number. The unknown-cause fallback may quote the message Xero sent, and
 * only after redacting it again and clipping it. A name Xero echoes back (the
 * duplicate-contact wording does) is never repeated in the plain version; it stays
 * in `technicalDetail`.
 *
 * HOW IT DECIDES, in order: a code the app itself names, then Xero's own wording
 * (a table; each entry has a test), then the HTTP status, then a generic line.
 * Never blank, never throws.
 */
export interface XeroFailureInput {
  /** `lastErrorCode`: an HTTP status as text, or a code the app names itself. */
  code: string | null | undefined;
  /** `lastErrorMessage`, already redacted on the way in. */
  message: string | null | undefined;
  /** `XeroSyncOperation.entityType`, for the noun ("invoice", "credit note"). */
  entityType?: string | null;
}

export type XeroFailureKind =
  | "DAILY_LIMIT"
  | "RATE_LIMITED"
  | "INVOICE_ALREADY_PAID"
  | "CREDIT_TOO_LOW"
  | "DUPLICATE_CONTACT"
  | "TIMED_OUT"
  | "NO_LINKED_INVOICE"
  | "REQUEST_KEY_REUSED"
  | "LOST_TRACK"
  | "PERIOD_LOCKED"
  | "ACCOUNT_CODE"
  | "CONTACT_ARCHIVED"
  | "RECORD_VOIDED"
  | "DETAIL_HIDDEN"
  | "NOT_CONNECTED"
  | "NOT_FOUND"
  | "XERO_DOWN"
  | "XERO_REJECTED"
  | "UNKNOWN";

export interface XeroFailureExplanation {
  kind: XeroFailureKind;
  /** One plain sentence: what happened. */
  headline: string;
  /** Why, in club terms. */
  whatItMeans: string;
  /** What the officer can do, including whether the app tries again itself. */
  nextStep: string;
  /** The stored code and redacted message, unchanged, for the disclosure and bug reports. */
  technicalDetail: string;
}

const RECORD_NOUN: Record<string, string> = {
  INVOICE: "invoice",
  CREDIT_NOTE: "credit note",
  PAYMENT: "payment",
  ALLOCATION: "credit allocation",
  CONTACT: "contact",
};

function nounFor(entityType: string | null | undefined): string {
  return (entityType && RECORD_NOUN[entityType]) || "record";
}

/** Xero's own sentences inside a stored JSON dump, however the dump is shaped. */
const XERO_TEXT_FIELD = /"(?:Message|Detail)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
/** Wording that says nothing about the cause. */
const GENERIC_XERO_TEXT = /^(a validation exception occurred|an error occurred( in xero\.?.*)?|bad ?request|validation ?exception)\.?$/i;

function unescapeJsonText(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/** Every specific sentence Xero put in the stored text, plus the text itself when it is not JSON. */
function xeroSentences(message: string): string[] {
  const found: string[] = [];
  for (const match of message.matchAll(XERO_TEXT_FIELD)) {
    const sentence = unescapeJsonText(match[1] ?? "").trim();
    if (sentence && !GENERIC_XERO_TEXT.test(sentence)) found.push(sentence);
  }
  if (!message.trimStart().startsWith("{") && !message.includes('"response"')) {
    found.push(message.trim());
  }
  return found;
}

/** "about 18 minutes" from a number of seconds. */
function roundedWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "until Xero allows requests again";
  if (seconds < 90) return "about a minute";
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`;
  const hours = Math.max(2, Math.round(seconds / 3600));
  return `about ${hours} hours`;
}

/** Stored 400s run to about 5000 characters, with Xero's sentence after the echoed request; bound the work on a pathological row. */
const MAX_ANALYSED_CHARS = 20_000;

function clip(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function statusOf(code: string | null | undefined): number | null {
  const parsed = code && /^\d{3}$/.test(code.trim()) ? Number(code.trim()) : null;
  return parsed;
}

interface Template {
  kind: XeroFailureKind;
  headline: string;
  whatItMeans: string;
  nextStep: string;
}

const SELF_RETRY =
  "The app tries again by itself where it can; if this row is still listed after the limit has reset, press Retry in background.";

function known(kind: XeroFailureKind, headline: string, whatItMeans: string, nextStep: string): Template {
  return { kind, headline, whatItMeans, nextStep };
}

/** Xero's own wordings, most specific first. Every entry has a test. */
function matchKnownWording(text: string, noun: string): Template | null {
  if (/daily api limit reached/i.test(text)) {
    const seconds = /retry after (\d+) seconds/i.exec(text);
    const wait = roundedWait(seconds ? Number(seconds[1]) : Number.NaN);
    return known(
      "DAILY_LIMIT",
      "Xero is limiting how many requests the club can make today.",
      `Nothing is wrong with this ${noun}. Xero allows a fixed number of requests a day and the club has used them up. The wait is ${wait}.`,
      SELF_RETRY,
    );
  }
  if (/\balready (?:been )?paid\b/i.test(text)) {
    return known(
      "INVOICE_ALREADY_PAID",
      "Xero refused to apply the credit because the invoice is already fully paid.",
      "The invoice was settled in Xero some other way, so the credit did not need to be applied to it there.",
      "Retry will not help. Check the invoice in Xero. If it is paid there, nothing more is needed in Xero; where this row offers “Resolve (fixed in Xero)”, use it to clear the row.",
    );
  }
  if (
    /allocation amount is greater than the amount remaining on the credit note|credit note cannot be allocated as (?:the )?amount is greater than (?:the )?amount (?:outstanding|remaining)/i.test(
      text,
    )
  ) {
    return known(
      "CREDIT_TOO_LOW",
      "Xero refused to apply the credit because the credit note has less credit left than the app expected.",
      "Some of the credit note was already used in Xero, for example an offset or a payment made there by hand, and the app was not told.",
      "Check the credit note in Xero. If the use was a mistake, reverse it there and press Retry. If it was deliberate, nothing in Xero needs changing.",
    );
  }
  if (/contact name .* is already assigned to another contact|contact name must be unique/i.test(text)) {
    return known(
      "DUPLICATE_CONTACT",
      "Xero refused to create this contact because another contact there already has the same name.",
      "Xero needs every contact name to be different. The name Xero objected to is in the technical details.",
      "In Xero, find the other contact with that name. If it is the same person, use that contact; if not, rename one of them. Then press Retry in background.",
    );
  }
  if (/no xero invoice linked to payment/i.test(text)) {
    return known(
      "NO_LINKED_INVOICE",
      "The app could not find the Xero invoice this payment belongs to.",
      `The payment has no invoice recorded in Xero, so there was nothing to attach the ${noun} to.`,
      "Check whether the booking's invoice exists in Xero. If it does not, retry the invoice first; then retry this.",
    );
  }
  if (/idempotency[\s_-]?key/i.test(text) && /different|already|reuse|mismatch/i.test(text)) {
    return known(
      "REQUEST_KEY_REUSED",
      "Xero saw the same request key used for a different request.",
      "The app labels each request with a unique key so that a repeat is never done twice. Xero says this key was already used for something different, usually because the record changed between attempts.",
      "Check in Xero whether the change already went through. If it did, use “Resolve (fixed in Xero)”. If it did not, ask a developer before retrying.",
    );
  }
  if (/stuck running past the staleness threshold/i.test(text)) {
    return known(
      "LOST_TRACK",
      "The app lost track of this job.",
      "It was started but never finished, usually because the app restarted. Whether Xero received it is not known.",
      `Check Xero for the ${noun} first. If it is there, use “Resolve (fixed in Xero)”; if not, press Retry in background.`,
    );
  }
  if (/period is locked|lock date|locked period|before the (?:end of year )?lock/i.test(text)) {
    return known(
      "PERIOD_LOCKED",
      "Xero refused because the date falls in a period that has been locked.",
      "Someone with access to the club's Xero books has closed that period, so no new entries can be dated in it.",
      "Ask whoever manages the Xero books to unlock the period or say which date to use, then press Retry in background.",
    );
  }
  if (/account code .*(?:archived|not valid|invalid|does not exist|doesn't exist|isn't valid)|account .*is archived/i.test(text)) {
    return known(
      "ACCOUNT_CODE",
      "Xero refused because an account code the app uses is missing or archived.",
      "The app sends each line to a fixed account in the club's Xero chart of accounts, and Xero no longer accepts that account.",
      "Compare the account codes in the app's Xero settings with the chart of accounts in Xero, correct them, then press Retry in background.",
    );
  }
  if (/contact .*archived|archived contact/i.test(text)) {
    return known(
      "CONTACT_ARCHIVED",
      "Xero refused because the contact has been archived there.",
      "The member's contact in Xero was archived, so nothing new can be raised against it.",
      "Restore the contact in Xero, then press Retry in background.",
    );
  }
  if (/(?:invoice|credit note).*\b(?:voided|deleted)\b|has been voided/i.test(text)) {
    return known(
      "RECORD_VOIDED",
      `Xero refused because the ${noun} it needed has been voided or deleted.`,
      "Someone voided or deleted it in Xero after the app last saw it.",
      "Check the record in Xero. If that was intended, use “Resolve (fixed in Xero)”.",
    );
  }
  if (/timed out|etimedout|esockettimedout|socket hang up/i.test(text)) {
    return known(
      "TIMED_OUT",
      "Xero did not answer in time.",
      `The request was sent but no reply came back, so the app cannot be sure whether Xero received it.`,
      "Press Retry in background. Each request carries a unique key, so Xero ignores a repeat of one it already completed. Check the record in Xero first if you want to be sure.",
    );
  }
  return null;
}

function matchStatus(status: number | null, noun: string, sentence: string | null): Template | null {
  if (status === 401 || status === 403) {
    return known(
      "NOT_CONNECTED",
      "Xero refused the app's login.",
      "The connection between the app and Xero has expired or been revoked.",
      "Reconnect Xero in Admin > Xero, then press Retry in background.",
    );
  }
  if (status === 404) {
    return known(
      "NOT_FOUND",
      `Xero could not find the ${noun}.`,
      "It was deleted in Xero, or the app's link to it is out of date.",
      "Check Xero. If the record is gone and that was intended, use “Resolve (fixed in Xero)”; otherwise press Retry in background.",
    );
  }
  if (status === 429) {
    return known(
      "RATE_LIMITED",
      "Xero asked the app to slow down.",
      `Nothing is wrong with this ${noun}; too many requests were sent in a short time.`,
      "Press Retry in background in a few minutes.",
    );
  }
  if (status !== null && status >= 500) {
    return known(
      "XERO_DOWN",
      "Xero had a problem on its own side.",
      `Nothing is known to be wrong with this ${noun}.`,
      "Press Retry in background in a few minutes. If it keeps failing, check Xero's status page.",
    );
  }
  if (status !== null && status >= 400) {
    return known(
      "XERO_REJECTED",
      `Xero rejected the ${noun} the app sent.`,
      sentence ? `Xero said: “${sentence}”` : "Xero did not give a reason the app could read.",
      "Check the record in Xero and the technical details below. Retrying will fail again unless something has changed.",
    );
  }
  return null;
}

export function explainXeroFailure(input: XeroFailureInput): XeroFailureExplanation {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const rawMessage = typeof input.message === "string" ? input.message : "";
  const message = rawMessage.trim();
  const noun = nounFor(input.entityType);
  const technicalDetail = [code, message].filter(Boolean).join(": ") || "No detail was recorded.";

  const done = (template: Template): XeroFailureExplanation => ({ ...template, technicalDetail });

  try {
    if (code === CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE) {
      return done(
        known(
          "CREDIT_TOO_LOW",
          "Xero refused to apply the credit because the credit note has less credit left than the app expected.",
          "The credit note was used in Xero directly, for example an offset or a payment made there, and the app was not told.",
          "For a booking's credit the app brings its own record into line with Xero by itself and closes this row. Check the credit note in Xero if the row stays.",
        ),
      );
    }
    if (code === XERO_ORPHANED_STALE_RUNNING_ERROR_CODE) {
      return done(
        known(
          "LOST_TRACK",
          "The app lost track of this job.",
          "It was started but never finished, usually because the app restarted. Whether Xero received it is not known.",
          `Check Xero for the ${noun} first. If it is there, use “Resolve (fixed in Xero)”; if not, press Retry in background.`,
        ),
      );
    }

    // A message that is only a redaction marker carries no cause at all.
    if (!message || /^(?:\d{3}:\s*)?\[REDACTED\]$/.test(message)) {
      return done(
        known(
          "DETAIL_HIDDEN",
          `Xero refused this ${noun}, but the reason is not shown.`,
          "The detail was hidden because it may contain personal information.",
          "Open the technical details, or check the record in Xero.",
        ),
      );
    }

    const analysed = message.slice(0, MAX_ANALYSED_CHARS);
    const sentences = xeroSentences(analysed);
    const searchText = [analysed, ...sentences].join(" \n ");
    const status = statusOf(code);

    const byWording = matchKnownWording(searchText, noun);
    if (byWording) return done(byWording);

    if (/rate limit|too many requests/i.test(searchText)) {
      return done(matchStatus(429, noun, null) as Template);
    }

    const first = sentences[0];
    // Clip before redacting so the redaction scan is bounded, then clip again for the final length.
    const sentence = first ? clip(redactSensitiveText(clip(first, 400))) : null;
    const byStatus = matchStatus(status, noun, sentence);
    if (byStatus) return done(byStatus);

    return done(
      known(
        "UNKNOWN",
        `Syncing this ${noun} to Xero failed.`,
        sentence ? `The recorded reason is: “${sentence}”` : "The app could not read a reason from what was recorded.",
        "Open the technical details. If you cannot tell what is wrong, check the record in Xero or ask a developer.",
      ),
    );
  } catch {
    return done(
      known(
        "UNKNOWN",
        `Syncing this ${noun} to Xero failed.`,
        "The app could not read a reason from what Xero sent.",
        "Open the technical details. If you cannot tell what is wrong, check the record in Xero or ask a developer.",
      ),
    );
  }
}
