import sanitizeHtml from "sanitize-html";
import { escapeHtml } from "@/lib/email-templates/escape";

/**
 * Rich email bodies (fork #38, owner decision 25 Aug 2026: the email body
 * editor works like the /message-board composer — in-place styling, stored
 * as sanitised HTML).
 *
 * THE POLICY IS THE CONTROL, exactly as `club-post-html.ts` puts it for the
 * message board: the editor is convenience, and everything an admin submits
 * is reduced to this allowlist on SAVE and again at RENDER (defence in
 * depth). The vocabulary is deliberately smaller than the message board's —
 * bold/italic/underline, bullet and numbered lists, and block text-align —
 * because an email must stay on the club theme in every mail client: no
 * colours, fonts, sizes, images or links in v1 (each is a possible
 * follow-up, and the message board's colour/font CLASSES have no
 * inline-style mapping a mail client could read anyway).
 *
 * `{{token}}` markers are plain text to this policy and pass through
 * untouched; substitution happens at render time with every VALUE
 * HTML-escaped, so no token value can smuggle markup into the body it lands
 * in.
 */

const EMAIL_BODY_TAGS = [
  "h2",
  "p",
  "div",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ul",
  "ol",
  "li",
  "span",
];

const TEXT_ALIGN_VALUES = [/^left$/, /^right$/, /^center$/];

const SAVE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: EMAIL_BODY_TAGS,
  // Every BLOCK tag may carry the alignment the toolbar writes onto it —
  // review finding 4: with p/div only, centring a heading or a list item
  // saved successfully and silently arrived left-aligned.
  allowedAttributes: {
    p: ["style"],
    div: ["style"],
    h2: ["style"],
    ul: ["style"],
    ol: ["style"],
    li: ["style"],
  },
  allowedStyles: {
    "*": { "text-align": TEXT_ALIGN_VALUES },
  },
  // Text outside any tag is fine; disallowed tags drop but their TEXT
  // survives (sanitize-html's default), so pasting rich content degrades to
  // its words rather than vanishing.
};

/**
 * A half-selected Ctrl-B can split a token across tags
 * (`<b>{{first</b>Name}}`): text extraction JOINS across tags, so validation
 * would approve a token the render regex (which cannot see through tags)
 * would silently drop — review finding H2. Repair at the storage boundary:
 * strip tags INSIDE any `{{…}}` span, then re-sanitise so the tags the
 * repair unbalanced are closed. The whole token ends up formatted, which is
 * the sane reading of the author's half-bolding.
 */
function repairSplitTokens(html: string): string {
  return html.replace(/\{\{[^{}]*\}\}/g, (span) =>
    span.replace(/<[^<>]*>/g, ""),
  );
}

export function sanitiseEmailBodyHtml(input: string): string {
  if (typeof input !== "string" || input.trim() === "") return "";
  const sanitised = sanitizeHtml(input, SAVE_OPTIONS);
  const repaired = repairSplitTokens(sanitised);
  return (
    repaired === sanitised ? sanitised : sanitizeHtml(repaired, SAVE_OPTIONS)
  ).trim();
}

/**
 * The plain-text form of a rich body — the `clubPostHtmlToText` pattern.
 * Fills `bodyText` on save, so audit rows, the stale-content diff, and token
 * validation (allowed/required/sensitive) keep operating on text with line
 * structure that matches how the body reads.
 */
export function emailBodyHtmlToText(html: string): string {
  return htmlToLineText(html, "- ");
}

/**
 * The VALIDATION-facing form of a rich body: identical to
 * `emailBodyHtmlToText` except list items carry NO `- ` marker.
 *
 * The marker is synthetic — injected by the extraction, not typed by the
 * admin — and `SIGN_CARRYING_TOKEN_PATTERN`'s `[-+]\s*` cannot tell it from
 * an authored minus, so `<li>{{promoSummary}}</li>` derived WITH the marker
 * is refused as a sign the author never wrote (ultrareview nit). Validation
 * therefore reads this form; the stored/delivered `bodyText` keeps the
 * marker so the text/plain part still renders lists as lists.
 */
export function emailBodyHtmlToValidationText(html: string): string {
  return htmlToLineText(html, "");
}

function htmlToLineText(html: string, listMarker: string): string {
  if (typeof html !== "string" || html.trim() === "") return "";
  // A closing paragraph is a BLOCK boundary (blank line), so the plain-path
  // conventions the derived text feeds — blank-line blocks, the diff, token
  // validation — read the way the rich body looks. Lines inside a block
  // (<br>, list items, divs) are single newlines.
  const withBreaks = html
    .replace(/<\/(p|h2)>/gi, "\n\n")
    .replace(/<\/(div|li)>/gi, "\n")
    // The same "- " marker the sent text/plain part gives list items
    // (htmlToPlainText), so the derived text and the delivered plain part
    // read the same way (drift lens one-liner). The validation form passes
    // "" here — see emailBodyHtmlToValidationText.
    .replace(/<li[^>]*>/gi, listMarker)
    .replace(/<br\s*\/?>/gi, "\n");
  const text = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
  });
  // sanitize-html RE-ESCAPES text on output (verified against 2.17.6 — the
  // club-post comment claiming otherwise is wrong; review finding M4), so
  // decode the entities it emits or every derived body reads "Tom &amp;
  // Jerry" in audit rows, diffs and any plain-path fallback. Ampersand LAST,
  // so "&amp;lt;" decodes to the literal "&lt;" text it was, not to "<".
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Substitute `{{token}}` values into a SANITISED HTML body. Every value is
 * HTML-escaped, and a multi-line pre-composed block value (promoSummary,
 * paymentOutcome, ical…) keeps its line structure as `<br>`s. An absent or
 * null value renders as nothing, matching the plain-text path's convention.
 */
export function renderHtmlTemplateString(
  html: string,
  data: Record<string, string | number | boolean | null | undefined>,
): string {
  return html.replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
    const value = data[tokenName.trim()];
    if (value === null || value === undefined) return "";
    return escapeHtml(String(value)).replace(/\r?\n/g, "<br>");
  });
}

// Inline spacing mail clients would otherwise not apply — the shell's cell
// carries the font, colour and size, which these children inherit.
const RENDER_STYLE: Record<string, string> = {
  h2: "margin: 0 0 16px 0; font-size: 22px; font-weight: 700; line-height: 1.3;",
  p: "margin: 0 0 12px 0; line-height: 1.6;",
  div: "margin: 0 0 12px 0; line-height: 1.6;",
  ul: "margin: 0 0 12px 0; padding-left: 22px;",
  ol: "margin: 0 0 12px 0; padding-left: 22px;",
  li: "margin: 0 0 4px 0;",
};

/**
 * The final render pass over a rich body with tokens already substituted:
 * re-sanitise (defence in depth — the stored copy should already be clean)
 * and stamp the inline spacing styles a mail client needs, preserving any
 * allowlisted text-align the author set.
 */
export function renderEmailBodyHtml(substitutedHtml: string): string {
  const transformTags: sanitizeHtml.IOptions["transformTags"] =
    Object.fromEntries(
      Object.entries(RENDER_STYLE).map(([tag, style]) => [
        tag,
        (tagName: string, attribs: sanitizeHtml.Attributes) => ({
          tagName,
          attribs: {
            ...attribs,
            style: attribs.style ? `${style} ${attribs.style}` : style,
          },
        }),
      ]),
    );
  return sanitizeHtml(substitutedHtml, {
    ...SAVE_OPTIONS,
    // The render pass ADDS the spacing styles, so the style allowlist widens
    // to exactly what RENDER_STYLE stamps plus the author's text-align.
    allowedStyles: {
      "*": {
        "text-align": TEXT_ALIGN_VALUES,
        margin: [/^0 0 (?:4|12|16)px 0$/],
        "line-height": [/^1\.[36]$/],
        "padding-left": [/^22px$/],
        "font-size": [/^22px$/],
        "font-weight": [/^700$/],
      },
    },
    allowedAttributes: {
      ...Object.fromEntries(EMAIL_BODY_TAGS.map((tag) => [tag, ["style"]])),
    },
    transformTags,
  }).trim();
}

/**
 * Lossless upgrade of a legacy PLAIN body for the rich editor: blank-line
 * blocks become paragraphs, inner newlines become `<br>`. Used when an admin
 * opens an override saved before the feature; nothing is stored until they
 * save.
 */
export function plainTextToEmailBodyHtml(bodyText: string): string {
  const blocks = bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  // The FIRST block becomes an <h2>, because that is what the plain path
  // renders it as (`plainTextEmailTemplate` → `heading()`) — without this, a
  // no-op re-save of an untouched body would silently lose its heading
  // (review finding M5).
  return blocks
    .map((block, index) => {
      const inner = escapeHtml(block).replace(/\n/g, "<br>");
      return index === 0 ? `<h2>${inner}</h2>` : `<p>${inner}</p>`;
    })
    .join("");
}
