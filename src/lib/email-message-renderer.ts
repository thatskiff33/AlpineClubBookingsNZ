import { layout, plainTextEmailTemplate } from "@/lib/email-templates/layout";
import {
  renderEmailBodyHtml,
  renderHtmlTemplateString,
} from "@/lib/email-body-html";
import {
  applyEmailMessageSettingsToHtml,
  applyEmailMessageSettingsToSubject,
  buildEmailTemplateGlobalData,
  loadEmailMessageSettings,
  loadEmailMessageSettingsForLodge,
  type EmailMessageSettings,
} from "@/lib/email-message-settings";
import {
  APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
  getSensitiveEmailSubjectTokens,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import { findBracketAnnotations } from "@/lib/email-message-token-contract";
import { prisma } from "@/lib/prisma";
import { emailPalette, renderEmailHtml } from "@/lib/email-theme";

// The container a RICH override body (fork #38) renders inside: the same
// text colour and size `multilineBlock` gives the plain path, inherited by
// the sanitised children — the shell's own cell sets neither (review M5).
// Local to this module DELIBERATELY: `src/lib/email-templates/` is the #2689
// render-census directory, and a new exported render function there demands
// a byte pin this environment cannot generate (drift lens finding 1).
function richBodyContainer(html: string): string {
  const p = emailPalette();
  return `<div style="color: ${p.deep}; font-size: 15px;">${html}</div>`;
}

type EmailTemplateValue = string | number | boolean | null | undefined;
export type EmailTemplateData = Record<string, EmailTemplateValue>;

interface EmailTemplateOverrideRecord {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  // Fork #38: the rich-editor body, sanitised before storage. Optional so a
  // mocked or pre-migration row reads as absent — a legacy body renders
  // through the plain path unchanged.
  bodyHtml?: string | null;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
}

export interface PreparedEmailMessage {
  subject: string;
  html: string;
  settings: EmailMessageSettings;
  overrideApplied: boolean;
  bodyOverrideApplied: boolean;
}

interface EmailTemplateValidationIssue {
  code:
    | "unknown_template"
    | "unknown_token"
    | "disallowed_token"
    | "missing_required_token"
    | "missing_required_subject_token"
    | "forbidden_subject_phrase"
    | "sign_prefixed_token"
    | "sensitive_subject_token"
    | "subject_line_break"
    | "raw_html"
    | "unsafe_link"
    | "bracket_annotation";
  field?: "subject" | "bodyText";
  message: string;
  tokens?: string[];
  links?: string[];
  annotations?: string[];
  // #2774: the subject wording that has to come out. Not `annotations`, which the
  // #2320 banner surface reads as "[only when ...]" markers the editor strips.
  phrases?: string[];
}

export interface EmailTemplateValidationResult {
  valid: boolean;
  issues: EmailTemplateValidationIssue[];
  unknownTokens: string[];
  disallowedTokens: string[];
  missingRequiredTokens: string[];
  missingRequiredSubjectTokens: string[];
  forbiddenSubjectPhrases: string[];
  signPrefixedTokens: string[];
  sensitiveSubjectTokens: string[];
  unsafeLinks: string[];
  bracketAnnotations: string[];
}

// #2267: these tokens render their own sign — "-$30.00" for a discount,
// "+$1,370.00" for a promo that raises the price — and render nothing at all
// when no promo applied. Typing a minus in front of one ("Discount:
// -{{promoAdjustment}}") re-creates the exact incident #2267 fixed: a member
// reading "Discount: -+$1,370.00" on a surcharge, or a bare "Discount: -" on a
// booking with no promo. The editor rejects it at save time instead.
//
// #2328 adds {{creditNote}} on the same grounds: its first line already reads
// "Account credit applied: -$120.00", so a body written as "-{{creditNote}}"
// renders "--$120.00" for a member who used credit and a bare "-" for the
// majority who did not.
const SIGN_CARRYING_TOKEN_PATTERN =
  /[-+]\s*\{\{\s*(creditNote|promoAdjustment|promoSummary)\s*\}\}/g;

// #2267: plain-English copy for the required tokens whose requirement can be
// satisfied more than one way (see REQUIRED_TOKEN_ALTERNATIVES). Naming a token
// and stopping leaves an admin guessing whether their own hand-written wording
// counts, so the message says what the email must show the member and which
// tokens do that. Keyed by token name — a token name means the same thing in
// every template that supplies it.
const REQUIRED_TOKEN_GUIDANCE: Record<string, string> = {
  promoSummary:
    "this email must show members how a promo code changed their price — keep {{promoSummary}}, or show the adjustment yourself with {{promoAdjustment}} or {{discount}} (a {{subtotal}} line on its own is not an explanation)",
  doorCodeNote:
    "this email must tell members how to get into the lodge — keep {{doorCodeNote}}, or write your own label around the bare {{doorCode}} value",
};

// #2774: the same plain-English treatment for the SUBJECT requirements. Naming a
// token and stopping would read as pedantry on the one alert where a wrong subject
// is a statement about money, so the message says what the subject has to be able
// to say and why a fixed wording cannot say it.
const REQUIRED_SUBJECT_TOKEN_GUIDANCE: Record<string, string> = {
  handBackConflictLabel:
    "this email is sent in two opposite directions — a refund that was withheld, and one that may have paid a member twice — so its subject must keep {{handBackConflictLabel}}, which fills in whichever happened. A subject with the wording typed in by hand would title every double payment as a withheld refund",
};

/**
 * The other half of the same rule (#2774). Keeping the token is not enough: a subject
 * that keeps it AND states a direction beside it — "Automatic refund withheld -
 * {{handBackConflictLabel}}" — renders the wrong claim in the words an inbox truncates
 * to. The phrases themselves are derived from the sender's own labels in
 * `email-message-registry.ts`; this is only the plain-English reason shown to the
 * admin whose save is refused, because "remove the phrase 'withheld'" on its own
 * teaches nothing about why.
 */
const FORBIDDEN_SUBJECT_PHRASE_GUIDANCE: Record<string, string> = {
  "admin-late-capture-hand-back-conflict":
    "This alert goes out in two opposite directions about money — a refund this system WITHHELD, and one that may have paid a member TWICE — and {{handBackConflictLabel}} already fills in whichever happened for each send. Wording of your own beside it would title the other case wrongly, and an operator who files by subject would file a suspected double payment as nothing to do. Say what the email is about and leave the direction to the token",
};

/**
 * #2774: compare subject prose the way a reader sees it, not byte for byte. Tokens are
 * removed first (the direction is ALLOWED to arrive through `{{handBackConflictLabel}}`
 * — that is the whole mechanism, and a future token whose NAME contained a forbidden
 * word must not be mistaken for prose), then case and every kind of dash or run of
 * whitespace are flattened, so an admin who types a hyphen where the label carries an
 * em dash is treated the same as one who copies it exactly.
 */
function normaliseSubjectProse(value: string): string {
  return value
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .toLowerCase()
    .replace(/[-‐-―\s]+/g, " ")
    .trim();
}

function findSignPrefixedTokens(value: string): string[] {
  return Array.from(
    new Set(Array.from(value.matchAll(SIGN_CARRYING_TOKEN_PATTERN), (m) => m[1])),
  );
}

function extractTemplateTokens(value: string): string[] {
  return Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

// test seam
export function validateApprovedTemplateTokens(values: string[]): string[] {
  return Array.from(
    new Set(
      values.flatMap(extractTemplateTokens).filter(
        (token) => !APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token),
      ),
    ),
  );
}

function findRawHtmlFields({
  subject,
  bodyText,
}: {
  subject: string;
  bodyText: string;
}): Array<"subject" | "bodyText"> {
  const rawHtmlPattern = /<\/?[a-z][^>]*>/i;
  return [
    rawHtmlPattern.test(subject) ? "subject" : null,
    rawHtmlPattern.test(bodyText) ? "bodyText" : null,
  ].filter((field): field is "subject" | "bodyText" => field !== null);
}

function normalizeLinkCandidate(value: string): string {
  return value.replace(/[.;]+$/g, "");
}

function findUnsafeTemplateLinks(values: string[]): string[] {
  const unsafe = new Set<string>();
  const linkPattern =
    /(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|mailto:[^\s<>"']+|javascript:[^\s<>"']+|data:[^\s<>"']+|vbscript:[^\s<>"']+|www\.[^\s<>"']+)/gi;

  for (const value of values) {
    const sampleRendered = value.replace(/\{\{[^{}]+\}\}/g, "sample");
    for (const match of sampleRendered.matchAll(linkPattern)) {
      const link = normalizeLinkCandidate(match[0]);
      const lower = link.toLowerCase();
      if (lower.startsWith("http://") || lower.startsWith("https://")) {
        try {
          new URL(link);
          continue;
        } catch {
          unsafe.add(link);
          continue;
        }
      }
      if (lower.startsWith("mailto:")) {
        if (!/[\r\n]/.test(link)) continue;
      }
      unsafe.add(link);
    }
  }

  return Array.from(unsafe);
}

export function validateEmailTemplateContent({
  templateName,
  subject,
  bodyText,
}: {
  templateName: string;
  subject: string;
  bodyText: string;
}): EmailTemplateValidationResult {
  const definition = getEmailTemplateDefinition(templateName);
  const issues: EmailTemplateValidationIssue[] = [];
  const values = [subject, bodyText];
  const subjectTokens = Array.from(new Set(extractTemplateTokens(subject)));
  const bodyTokens = Array.from(new Set(extractTemplateTokens(bodyText)));
  const tokens = Array.from(new Set([...subjectTokens, ...bodyTokens]));
  const unknownTokens = tokens.filter(
    (token) => !APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token),
  );

  if (!definition) {
    issues.push({
      code: "unknown_template",
      message: "Unknown email template",
    });
  }

  if (unknownTokens.length > 0) {
    issues.push({
      code: "unknown_token",
      message: "Unknown template tokens",
      tokens: unknownTokens,
    });
  }

  const allowedTokenSet = new Set(definition?.allowedTokens ?? []);
  const disallowedTokens = definition
    ? tokens.filter((token) => !allowedTokenSet.has(token))
    : [];
  if (disallowedTokens.length > 0) {
    issues.push({
      code: "disallowed_token",
      message: "Template tokens are not allowed for this message",
      tokens: disallowedTokens,
    });
  }

  // Required tokens are body content (door codes, credential links), so they
  // must be present in the body itself — a token in the subject does not
  // satisfy the requirement. The converse is enforced separately, just below:
  // #2774 added a small SUBJECT requirement table for the one thing a subject
  // has to be able to promise, and neither field's requirement is satisfied by
  // the other. An empty body override falls back to the default
  // body, which already carries the required tokens, so it is not checked.
  // A required token may also be satisfied by a registered alternative that
  // carries the same information (#2267): the booking-confirmed body now uses
  // the pre-composed {{doorCodeNote}}, but an override saved earlier writes
  // its own "Door code: {{doorCode}}" line and must stay valid and re-savable.
  const requiredTokenSet = new Set(definition?.requiredTokens ?? []);
  const requiredTokenAlternatives = definition?.requiredTokenAlternatives ?? {};
  const bodyTokenSet = new Set(bodyTokens);
  const missingRequiredTokens =
    bodyText.trim().length > 0
      ? Array.from(requiredTokenSet).filter(
          (token) =>
            !bodyTokenSet.has(token) &&
            !(requiredTokenAlternatives[token] ?? []).some((alternative) =>
              bodyTokenSet.has(alternative),
            ),
        )
      : [];
  if (missingRequiredTokens.length > 0) {
    const guidance = missingRequiredTokens
      .map((token) => REQUIRED_TOKEN_GUIDANCE[token])
      .filter((entry): entry is string => Boolean(entry));
    issues.push({
      code: "missing_required_token",
      message:
        guidance.length > 0
          ? `Required template tokens are missing from the body: ${guidance.join("; ")}`
          : "Required template tokens are missing from the body",
      tokens: missingRequiredTokens,
    });
  }

  // #2774: the SUBJECT half, and it is a different rule rather than the same one
  // widened. A subject may not drop a token the registry declares load-bearing
  // FOR THE SUBJECT — today only the direction on the late-capture hand-back
  // conflict alert, whose two arms say opposite things about whether money left
  // the club. Same empty-value rule as the body: a blank stored subject means
  // "use the built-in wording", which already carries the token, so it passes.
  //
  // This is what makes the protection structural instead of advisory. The
  // shipped `defaultSubject` carrying `{{handBackConflictLabel}}` already covers
  // the admin who saves the form untouched, which is the common case; this
  // covers the admin who rewrites the subject in their own words and would
  // otherwise pin every future send to one direction. No alternatives table:
  // the label is composed by the sender precisely so there is one spelling of
  // it, and a hand-written substitute is the failure being prevented.
  const requiredSubjectTokenSet = new Set(definition?.requiredSubjectTokens ?? []);
  const subjectTokenSet = new Set(subjectTokens);
  const missingRequiredSubjectTokens =
    subject.trim().length > 0
      ? Array.from(requiredSubjectTokenSet).filter(
          (token) => !subjectTokenSet.has(token),
        )
      : [];
  if (missingRequiredSubjectTokens.length > 0) {
    const guidance = missingRequiredSubjectTokens
      .map((token) => REQUIRED_SUBJECT_TOKEN_GUIDANCE[token])
      .filter((entry): entry is string => Boolean(entry));
    issues.push({
      code: "missing_required_subject_token",
      field: "subject",
      message:
        guidance.length > 0
          ? `Required template tokens are missing from the subject: ${guidance.join("; ")}`
          : "Required template tokens are missing from the subject",
      tokens: missingRequiredSubjectTokens,
    });
  }

  // #2774, the other half: a subject that KEEPS the direction token and states a
  // direction beside it in its own words. The presence check above passes such a
  // subject, and the stored subject replaces the sender's computed one whole, so the
  // double-payment arm would go out titled "Automatic refund withheld …". Same
  // empty-value rule as every other subject rule: a blank stored subject means "use
  // the built-in wording", which is the token alone.
  const normalisedSubjectProse =
    subject.trim().length > 0 ? normaliseSubjectProse(subject) : "";
  const forbiddenSubjectPhrases = (definition?.forbiddenSubjectPhrases ?? []).filter(
    (phrase) => {
      const normalisedPhrase = normaliseSubjectProse(phrase);
      return (
        normalisedPhrase.length > 0 &&
        normalisedSubjectProse.includes(normalisedPhrase)
      );
    },
  );
  if (forbiddenSubjectPhrases.length > 0) {
    const guidance = FORBIDDEN_SUBJECT_PHRASE_GUIDANCE[templateName];
    issues.push({
      code: "forbidden_subject_phrase",
      field: "subject",
      message: guidance
        ? `Take this wording out of the subject: "${forbiddenSubjectPhrases.join('", "')}". ${guidance}`
        : `Take this wording out of the subject: "${forbiddenSubjectPhrases.join('", "')}"`,
      phrases: forbiddenSubjectPhrases,
    });
  }

  const signPrefixedByField = {
    subject: findSignPrefixedTokens(subject),
    bodyText: findSignPrefixedTokens(bodyText),
  };
  const signPrefixedTokens = Array.from(
    new Set([...signPrefixedByField.subject, ...signPrefixedByField.bodyText]),
  );
  for (const field of ["subject", "bodyText"] as const) {
    const fieldTokens = signPrefixedByField[field];
    if (fieldTokens.length > 0) {
      issues.push({
        code: "sign_prefixed_token",
        field,
        message:
          "Remove the plus or minus you typed in front of this token. It already includes its own sign — a discount reads -$30.00 and a promo that raises the price reads +$1,370.00 — and it renders nothing at all when no promo applied, so a sign of your own would leave a stray + or - in the email",
        tokens: fieldTokens,
      });
    }
  }

  // Subjects are persisted in EmailLog and travel in clear mail headers, so
  // secret-bearing tokens are never allowed in a subject line.
  const sensitiveSubjectTokenSet = getSensitiveEmailSubjectTokens(templateName);
  const sensitiveSubjectTokens = subjectTokens.filter((token) =>
    sensitiveSubjectTokenSet.has(token),
  );
  if (sensitiveSubjectTokens.length > 0) {
    issues.push({
      code: "sensitive_subject_token",
      field: "subject",
      message:
        "Sensitive tokens such as door codes and credential links cannot be used in email subjects",
      tokens: sensitiveSubjectTokens,
    });
  }

  if (/[\r\n]/.test(subject)) {
    issues.push({
      code: "subject_line_break",
      field: "subject",
      message: "Email subjects cannot contain line breaks",
    });
  }

  for (const field of findRawHtmlFields({ subject, bodyText })) {
    issues.push({
      code: "raw_html",
      field,
      message: "Email templates must be plain text, not raw HTML",
    });
  }

  const unsafeLinks = findUnsafeTemplateLinks(values);
  if (unsafeLinks.length > 0) {
    issues.push({
      code: "unsafe_link",
      message: "Email template links must use http, https, or mailto",
      links: unsafeLinks,
    });
  }

  // #2268 review (MED-1): the sweep cleaned the SHIPPED defaults of the
  // "[only when …]" authoring notes, but an override a club saved from the old
  // editor text still carries them and would keep sending them to recipients as
  // literal text forever. Guard 1's detector runs here at save time too, so the
  // junk cannot be (re-)saved. This BLOCKS the save, matching how the validator
  // treats every other contract violation (an unknown token blocks; so does
  // this) — the fix is one edit away, and a warn would let the same text keep
  // reaching members. Same rationale as guard 1: token braces are the only
  // legitimate markup, so anything square-bracketed is an authoring note the
  // render path can only print verbatim.
  const bracketFindings = findBracketAnnotations({
    [templateName]: { defaultSubject: subject, defaultBody: bodyText },
  });
  const bracketAnnotations = bracketFindings.flatMap(
    (finding) => finding.detail.split(" | "),
  );
  for (const finding of bracketFindings) {
    issues.push({
      code: "bracket_annotation",
      field: finding.field === "defaultSubject" ? "subject" : "bodyText",
      message:
        "Remove the square-bracketed note — emails render tokens and nothing else, so text like \"[only when a door code is set]\" is sent to the recipient word for word. If a line should appear only sometimes, use its pre-composed {{...Note}} token, which renders the whole line or nothing at all",
      annotations: finding.detail.split(" | "),
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    unknownTokens,
    disallowedTokens,
    missingRequiredTokens,
    missingRequiredSubjectTokens,
    forbiddenSubjectPhrases,
    signPrefixedTokens,
    sensitiveSubjectTokens,
    unsafeLinks,
    bracketAnnotations,
  };
}

const BOOKING_URL_TOKEN_SOURCE = String.raw`\{\{\s*bookingUrl\s*\}\}`;
const BOOKING_URL_TOKEN = new RegExp(BOOKING_URL_TOKEN_SOURCE, "i");
const BOOKING_URL_CTA_LABEL_TEXT_SOURCE = String.raw`(?:(?:view|open|manage|review|see)\s+(?:(?:this|the|your)\s+)?booking(?:\s+(?:details?|online))?(?:\s+here)?|booking(?:\s+(?:details?|link))?)`;
const BOOKING_URL_CTA_LABEL_SOURCE = String.raw`\b${BOOKING_URL_CTA_LABEL_TEXT_SOURCE}`;
const BOOKING_URL_INLINE_SEPARATOR =
  /(\s*(?:\||\u2022|\u00b7|\u2014|\u2013|;(?=\s)|&bull;|&middot;|<br\s*\/?>)\s*)/gi;
const BOOKING_URL_CTA = new RegExp(
  String.raw`(?:\s+(?:and|then)\s+|\s*)?${BOOKING_URL_CTA_LABEL_SOURCE}\s*(?::|[-\u2013\u2014])?\s*${BOOKING_URL_TOKEN_SOURCE}`,
  "gi",
);
const BOOKING_URL_CTA_LABEL_CORE = String.raw`${BOOKING_URL_CTA_LABEL_SOURCE}[ \t]*(?::|[-\u2013\u2014])?`;
const BOOKING_URL_CTA_EMPHASIZED_LABEL_CORE = String.raw`${BOOKING_URL_CTA_LABEL_TEXT_SOURCE}[ \t]*(?::|[-\u2013\u2014])?`;
const BOOKING_URL_CTA_LABEL_WITH_OPTIONAL_EMPHASIS = String.raw`(?:${BOOKING_URL_CTA_LABEL_CORE}|\*\*${BOOKING_URL_CTA_EMPHASIZED_LABEL_CORE}\*\*|__${BOOKING_URL_CTA_EMPHASIZED_LABEL_CORE}__)`;
const BOOKING_URL_CTA_LABEL_SUFFIX = new RegExp(
  String.raw`(?:^|[ \t]*(?:\||\u2022|\u00b7|\u2014|\u2013|;|&bull;|&middot;)[ \t]*)${BOOKING_URL_CTA_LABEL_WITH_OPTIONAL_EMPHASIS}[ \t]*$`,
  "i",
);
const BOOKING_URL_TOKEN_ONLY_LINE = new RegExp(
  String.raw`^[ \t]*${BOOKING_URL_TOKEN_SOURCE}[ \t]*$`,
  "i",
);
const BOOKING_URL_HTML_ANCHOR = new RegExp(
  String.raw`<a\b(?=[^>]*${BOOKING_URL_TOKEN_SOURCE})[^>]*>.*?<\/a\s*>`,
  "gi",
);
const BOOKING_URL_HTML_ANCHOR_TEXT = new RegExp(
  String.raw`<a\b[^>]*>[^<]*${BOOKING_URL_TOKEN_SOURCE}[^<]*<\/a\s*>`,
  "gi",
);
const BOOKING_URL_MARKDOWN_LINK = new RegExp(
  String.raw`\[[^\]\r\n]*\]\(\s*${BOOKING_URL_TOKEN_SOURCE}\s*\)`,
  "gi",
);

function findLastProtectedBookingSiblingEnd(value: string): number {
  const patterns = [
    /\{\{[^{}]+\}\}/g,
    /(?:https?:\/\/|mailto:|\/(?=[A-Za-z0-9]))[^\s<>"']+/gi,
    /[.!?](?=\s|$)/g,
  ];
  let lastEnd = 0;

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (BOOKING_URL_TOKEN.test(match[0])) continue;
      lastEnd = Math.max(lastEnd, (match.index ?? 0) + match[0].length);
    }
  }

  return lastEnd;
}

function findFirstProtectedBookingSiblingStart(value: string): number | null {
  const patterns = [
    /\{\{[^{}]+\}\}/g,
    /(?:https?:\/\/|mailto:|\/(?=[A-Za-z0-9]))[^\s<>"']+/gi,
  ];
  let firstStart: number | null = null;

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (BOOKING_URL_TOKEN.test(match[0])) continue;
      firstStart = Math.min(firstStart ?? (match.index ?? 0), match.index ?? 0);
    }
  }

  return firstStart;
}

function stripRemainingBookingUrlTokens(fragment: string): string {
  let rendered = fragment;
  let tokenMatch = BOOKING_URL_TOKEN.exec(rendered);

  while (tokenMatch?.index !== undefined) {
    const before = rendered.slice(0, tokenMatch.index);
    const after = rendered.slice(tokenMatch.index + tokenMatch[0].length);
    const prefixEnd = findLastProtectedBookingSiblingEnd(before);
    const prefix = before.slice(0, prefixEnd).trimEnd();
    const siblingStart = findFirstProtectedBookingSiblingStart(after);
    let suffix = "";

    if (siblingStart !== null) {
      const lead = after.slice(0, siblingStart);
      const boundaries = Array.from(
        lead.matchAll(
          /(?:\||\u2022|\u00b7|\u2014|\u2013|,|;|\b(?:and|then)\b)\s*/gi,
        ),
      );
      const lastBoundary = boundaries.at(-1);
      suffix = after
        .slice(
          lastBoundary
            ? (lastBoundary.index ?? 0) + lastBoundary[0].length
            : 0,
        )
        .trimStart();
    } else {
      const nextSentence = after.match(/^[^.!?]*[.!?]\s*([\s\S]+)$/);
      suffix = nextSentence?.[1]?.trimStart() ?? "";
    }

    rendered = prefix && suffix ? `${prefix} ${suffix}` : prefix + suffix;
    tokenMatch = BOOKING_URL_TOKEN.exec(rendered);
  }

  return rendered;
}

function stripBookingUrlFromFragment(fragment: string): string {
  const withoutKnownCta = fragment
    .replace(BOOKING_URL_HTML_ANCHOR, "")
    .replace(BOOKING_URL_HTML_ANCHOR_TEXT, "")
    .replace(BOOKING_URL_MARKDOWN_LINK, "")
    .replace(BOOKING_URL_CTA, "");
  return stripRemainingBookingUrlTokens(withoutKnownCta);
}

function stripUnavailableBookingUrlLine(line: string): string | null {
  if (!BOOKING_URL_TOKEN.test(line)) return line;

  const parts = line.split(BOOKING_URL_INLINE_SEPARATOR);
  const content = parts.filter((_part, index) => index % 2 === 0);
  const separators = parts.filter((_part, index) => index % 2 === 1);
  const renderedContent = content.map((part) =>
    BOOKING_URL_TOKEN.test(part) ? stripBookingUrlFromFragment(part) : part,
  );
  const keptIndexes = renderedContent
    .map((part, index) => (part.trim() ? index : -1))
    .filter((index) => index >= 0);

  const firstKeptIndex = keptIndexes[0];
  if (firstKeptIndex === undefined) return null;

  let rendered = renderedContent[firstKeptIndex] ?? "";
  for (let index = 1; index < keptIndexes.length; index += 1) {
    const contentIndex = keptIndexes[index];
    if (contentIndex === undefined) continue;
    // If one optional CTA was removed between two authored fragments, retain
    // the separator that introduced the next surviving fragment. This keeps
    // HTML breaks as breaks and avoids leaving a trailing pipe or bullet.
    rendered += separators[contentIndex - 1] ?? "";
    rendered += renderedContent[contentIndex];
  }
  return rendered.trimEnd();
}

function stripUnavailableBookingUrl(template: string): string {
  const parts = template.split(/(\r\n|\n|\r)/);
  const replacementLines = new Map<number, string | null>();
  let rendered = "";

  for (let index = 0; index + 2 < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const nextLine = parts[index + 2] ?? "";
    if (
      parts[index + 1] !== undefined &&
      BOOKING_URL_TOKEN_ONLY_LINE.test(nextLine)
    ) {
      const withoutCta = line.replace(BOOKING_URL_CTA_LABEL_SUFFIX, "").trimEnd();
      if (withoutCta !== line.trimEnd()) {
        // The relationship is deliberately exact and local: only a recognized
        // booking CTA suffix immediately followed by a token-only line is
        // removed. The suffix must start the line or follow a recognized action
        // separator, so unrelated prose cannot be truncated; a bearer-action
        // prefix remains on its line.
        replacementLines.set(index, withoutCta || null);
        replacementLines.set(index + 2, null);
      }
    }
  }

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const lineEnding = parts[index + 1] ?? "";
    if (replacementLines.has(index)) {
      const replacement = replacementLines.get(index);
      if (replacement !== null && replacement !== undefined) {
        rendered += replacement + lineEnding;
      }
      continue;
    }
    const stripped = stripUnavailableBookingUrlLine(line);
    if (stripped !== null) rendered += stripped + lineEnding;
  }

  return rendered;
}

// test seam
export function renderTemplateString(
  template: string,
  data: EmailTemplateData,
): string {
  // `bookingUrl` is deliberately optional: public contacts, aggregate messages,
  // and members without detail-page authority must not receive a dead or
  // privacy-leaking authenticated URL. Remove only its CTA when the authority
  // resolver supplied no URL. A club-authored override may put a bearer
  // payment/respond/consent action on the same line, and that action must
  // survive. A dedicated booking-link line is still removed as one clean unit.
  const renderable = data.bookingUrl
    ? template
    : stripUnavailableBookingUrl(template);
  return renderable.replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
    const key = tokenName.trim();
    const value = data[key];
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

// Defence in depth for subject rendering: even if a stored override slips a
// sensitive token into a subject (for example a row saved before save-time
// validation existed), the live value must never reach the subject, because
// EmailLog persists subjects for every template and mail headers travel in
// the clear.
function buildSubjectSafeTemplateData(
  data: EmailTemplateData,
  templateName?: string,
): EmailTemplateData {
  const sensitiveSubjectTokenSet = getSensitiveEmailSubjectTokens(templateName);
  const safe: EmailTemplateData = {};
  for (const [key, value] of Object.entries(data)) {
    if (!sensitiveSubjectTokenSet.has(key)) safe[key] = value;
  }
  return safe;
}

// Minimum length for the literal-value scrub below; shorter strings are too
// likely to collide with legitimate subject text, and they can never be
// template-substituted into a subject because of buildSubjectSafeTemplateData.
const SENSITIVE_SUBJECT_VALUE_MIN_LENGTH = 3;

// test seam
export function neutraliseSensitiveSubjectContent(
  subject: string,
  data: EmailTemplateData,
  templateName?: string,
): string {
  const sensitiveSubjectTokenSet = getSensitiveEmailSubjectTokens(templateName);
  // The alternation is built from a fixed internal token set, not user input; the
  // tokens are simple {{name}} identifiers with no ReDoS structure.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const sensitiveSubjectTokenPattern = new RegExp(
    `\\{\\{\\s*(?:${Array.from(sensitiveSubjectTokenSet).join("|")})\\s*\\}\\}`,
    "g",
  );
  let result = subject.replace(sensitiveSubjectTokenPattern, "");
  // Last-resort scrub: drop any live sensitive value that somehow reached the
  // subject string through a non-template path.
  for (const token of sensitiveSubjectTokenSet) {
    const value = data[token];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < SENSITIVE_SUBJECT_VALUE_MIN_LENGTH) continue;
    result = result.split(trimmed).join("");
  }
  if (result === subject) return subject;
  return result.replace(/\s{2,}/g, " ").trim();
}

async function loadTemplateOverride(
  templateName: string,
): Promise<EmailTemplateOverrideRecord | null> {
  const delegate = (prisma as unknown as {
    emailTemplateOverride?: {
      findUnique: (args: unknown) => Promise<EmailTemplateOverrideRecord | null>;
    };
  }).emailTemplateOverride;

  if (!delegate) return null;

  try {
    return await delegate.findUnique({ where: { templateName } });
  } catch {
    return null;
  }
}

function buildEmailTemplateData(
  settings: EmailMessageSettings,
  templateData?: EmailTemplateData,
): EmailTemplateData {
  return {
    ...buildEmailTemplateGlobalData(settings),
    ...(templateData ?? {}),
  };
}

export async function prepareEmailMessage({
  templateName,
  subject,
  html,
  templateData,
  lodgeId,
}: {
  templateName: string;
  subject: string;
  html: string;
  templateData?: EmailTemplateData;
  // Lodge whose identity (name, travel note, door code) this message carries
  // (multi-lodge phase 8). Omitted/null resolves the default lodge identity.
  lodgeId?: string | null;
}): Promise<PreparedEmailMessage> {
  const settings = await loadEmailMessageSettingsForLodge(lodgeId);
  const override = getEmailTemplateDefinition(templateName)
    ? await loadTemplateOverride(templateName)
    : null;
  const data = buildEmailTemplateData(settings, templateData);

  let nextSubject = subject;
  let nextHtml = html;
  let overrideApplied = false;
  let bodyOverrideApplied = false;

  if (override?.subject?.trim()) {
    // Subjects render without sensitive values so a stored override can never
    // substitute a door code or credential link into the subject line.
    nextSubject = renderTemplateString(
      override.subject.trim(),
      buildSubjectSafeTemplateData(data, templateName),
    );
    overrideApplied = true;
  }

  const overrideBodyHtml = override?.bodyHtml?.trim();
  const overrideBodyText = override?.bodyText?.trim();
  if (overrideBodyHtml) {
    // Fork #38: a rich-editor body. Tokens substitute with every VALUE
    // HTML-escaped, then the final sanitise-and-style pass runs (defence in
    // depth over the save-time sanitise), inside the same themed shell and
    // render gate (#2900) as every other body.
    nextHtml = await renderEmailHtml(() =>
      layout(
        richBodyContainer(
          renderEmailBodyHtml(renderHtmlTemplateString(overrideBodyHtml, data)),
        ),
      ),
    );
    overrideApplied = true;
    bodyOverrideApplied = true;
  } else if (overrideBodyText) {
    // A stored body override re-renders the whole themed shell, so it goes
    // through the render gate too (#2900). Every row saved before fork #38
    // lands here and renders byte-for-byte as it always has.
    nextHtml = await renderEmailHtml(() =>
      plainTextEmailTemplate(renderTemplateString(overrideBodyText, data)),
    );
    overrideApplied = true;
    bodyOverrideApplied = true;
  }

  return {
    subject: applyEmailMessageSettingsToSubject(
      neutraliseSensitiveSubjectContent(nextSubject, data, templateName),
      settings,
    ),
    html: applyEmailMessageSettingsToHtml(nextHtml, settings),
    settings,
    overrideApplied,
    bodyOverrideApplied,
  };
}

export async function renderEmailTemplatePreview({
  templateName,
  subject,
  bodyText,
  bodyHtml,
  templateData,
}: {
  templateName: string;
  subject: string;
  bodyText: string;
  // Fork #38: when the editor is previewing a rich body, it sends the HTML
  // and the render uses the same path a save-then-send would, so the admin
  // sees formatting exactly as members will receive it.
  bodyHtml?: string;
  templateData?: EmailTemplateData;
}) {
  const settings = await loadEmailMessageSettings();
  const data = buildEmailTemplateData(settings, templateData);
  // Preview subjects render with the same sensitive-token stripping as real
  // sends so the admin preview matches delivered mail.
  const renderedSubject = applyEmailMessageSettingsToSubject(
    neutraliseSensitiveSubjectContent(
      renderTemplateString(
        subject,
        buildSubjectSafeTemplateData(data, templateName),
      ),
      data,
      templateName,
    ),
    settings,
  );
  const trimmedBodyHtml = bodyHtml?.trim();
  const html = applyEmailMessageSettingsToHtml(
    await renderEmailHtml(() =>
      trimmedBodyHtml
        ? layout(
            richBodyContainer(
              renderEmailBodyHtml(
                renderHtmlTemplateString(trimmedBodyHtml, data),
              ),
            ),
          )
        : plainTextEmailTemplate(renderTemplateString(bodyText, data)),
    ),
    settings,
  );

  return {
    subject: renderedSubject,
    html,
  };
}
