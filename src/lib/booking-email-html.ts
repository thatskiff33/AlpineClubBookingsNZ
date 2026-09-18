import { getAppBaseUrl, sanitizeEmailHref } from "@/lib/app-url";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findBookingHref(html: string, fromIndex = 0) {
  const baseUrl = getAppBaseUrl().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `href="${baseUrl}\\/bookings(?:\\/[^"#?]*)?([?#][^"]*)?"`,
    "g",
  );
  return findAuthenticatedBookingHref(html, pattern, fromIndex);
}

function findAnyBookingHref(html: string, fromIndex = 0) {
  const pattern = new RegExp(
    // Unauthorized final sanitation must also catch a legacy hard-coded app
    // origin and relative hrefs. Rewriting authorized built-ins stays on the
    // stricter current-origin matcher above; this wider matcher only removes.
    'href="(?:https?:\\/\\/[^/"?#]+)?\\/bookings(?:\\/[^"#?]*)?([?#][^"]*)?"',
    "g",
  );
  return findAuthenticatedBookingHref(html, pattern, fromIndex);
}

// Match a complete visible absolute/root-relative URL candidate rather than
// searching for `/bookings/...` anywhere in text. The latter would corrupt an
// unrelated URL such as `/help?next=/bookings/bk_1`. The prefix is retained so
// a candidate can be removed without changing its surrounding prose.
const VISIBLE_URL_CANDIDATE_PATTERN =
  /(^|[\s([{"'=,:;])((?:https?:\/\/|\/)[^\s<>"']+)/gi;
const ESCAPED_TEXT_DELIMITER_PATTERN = /&(?:quot|#39|apos|lt|gt|nbsp);/i;
const TRAILING_TEXT_PUNCTUATION_PATTERN = /[),.!\]}]+$/;

function splitVisibleUrlCandidate(candidate: string): {
  url: string;
  trailing: string;
} {
  // `plainTextEmailTemplate` escapes quotes around a URL. Do not consume the
  // closing entity as part of the candidate being removed.
  const delimiterIndex = candidate.search(ESCAPED_TEXT_DELIMITER_PATTERN);
  const escapedDelimiter =
    delimiterIndex < 0 ? "" : candidate.slice(delimiterIndex);
  const withoutDelimiter =
    delimiterIndex < 0 ? candidate : candidate.slice(0, delimiterIndex);
  const punctuation =
    withoutDelimiter.match(TRAILING_TEXT_PUNCTUATION_PATTERN)?.[0] ?? "";

  return {
    url: punctuation
      ? withoutDelimiter.slice(0, -punctuation.length)
      : withoutDelimiter,
    trailing: `${punctuation}${escapedDelimiter}`,
  };
}

function isAuthenticatedBookingDetailUrl(candidate: string): boolean {
  try {
    // Text rendered through plainTextEmailTemplate represents `&` as `&amp;`.
    // Decode only that URL delimiter for parsing; the delivered copy itself is
    // never decoded or rewritten.
    const parsed = new URL(
      candidate.replace(/&amp;/gi, "&"),
      "https://visible-email-url.invalid",
    );
    const { pathname } = parsed;
    if (pathname === "/bookings") return true;
    if (!pathname.startsWith("/bookings/")) return false;

    // `split` with a limit of one always yields a first element, even for the
    // empty string; an absent one is an empty segment, which is not `consent`
    // and so stays an authenticated detail path (#2800).
    const firstSegment =
      pathname.slice("/bookings/".length).split("/", 1)[0] ?? "";
    try {
      // Next decodes each route segment once. Mirror that single decode so an
      // encoded `consent` segment remains a bearer action, without treating a
      // double-encoded segment as equivalent. Malformed escapes fail closed
      // and are therefore stripped as an authenticated detail path.
      return decodeURIComponent(firstSegment).toLowerCase() !== "consent";
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function findAuthenticatedBookingHref(
  html: string,
  pattern: RegExp,
  fromIndex: number,
): RegExpExecArray | null {
  pattern.lastIndex = fromIndex;
  let match = pattern.exec(html);
  while (match) {
    const href = match[0].slice('href="'.length, -1);
    if (isAuthenticatedBookingDetailUrl(href)) return match;
    match = pattern.exec(html);
  }
  return null;
}

function sanitizeVisibleText(text: string): string {
  return text.replace(
    VISIBLE_URL_CANDIDATE_PATTERN,
    (match, prefix: string, candidate: string) => {
      const { url, trailing } = splitVisibleUrlCandidate(candidate);
      return isAuthenticatedBookingDetailUrl(url)
        ? `${prefix}${trailing}`
        : match;
    },
  );
}

function findHtmlMarkupEnd(html: string, startIndex: number): number {
  if (html.startsWith("<!--", startIndex)) {
    const commentEnd = html.indexOf("-->", startIndex + 4);
    return commentEnd < 0 ? html.length : commentEnd + "-->".length;
  }

  let quote: '"' | "'" | null = null;
  for (let index = startIndex + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return html.length;
}

function removeVisibleBookingDetailUrls(html: string): string {
  // Stored override bodies are HTML-escaped by plainTextEmailTemplate. Scan
  // only text nodes so URLs in attributes, comments, and layout markup are not
  // accidentally rewritten. Authorized output never calls this function.
  let next = "";
  let cursor = 0;
  while (cursor < html.length) {
    const markupStart = html.indexOf("<", cursor);
    if (markupStart < 0) {
      next += sanitizeVisibleText(html.slice(cursor));
      break;
    }

    next += sanitizeVisibleText(html.slice(cursor, markupStart));
    const markupEnd = findHtmlMarkupEnd(html, markupStart);
    next += html.slice(markupStart, markupEnd);
    cursor = markupEnd;
  }
  return next;
}

/** Whether HTML contains an authenticated booking-detail href (not a bearer action). */
export function hasBookingDetailHref(html: string): boolean {
  return findBookingHref(html) != null;
}

function removeBookingButtons(html: string): string {
  let next = html;
  let match = findAnyBookingHref(next);
  while (match) {
    const tableStart = next.lastIndexOf(
      '<table role="presentation" cellpadding="0" cellspacing="0"',
      match.index,
    );
    const tableEnd = next.indexOf("</table>", match.index);
    if (tableStart < 0 || tableEnd < 0) {
      next = `${next.slice(0, match.index)}${next.slice(match.index + match[0].length)}`;
    } else {
      next = `${next.slice(0, tableStart)}${next.slice(tableEnd + "</table>".length)}`;
    }
    match = findAnyBookingHref(next);
  }
  return removeVisibleBookingDetailUrls(next);
}

function appendBookingButton(html: string, bookingUrl: string): string {
  const safeUrl = escapeHtml(
    sanitizeEmailHref(bookingUrl, { baseUrl: getAppBaseUrl(), sameOrigin: true }),
  );
  const row = `
          <!-- Canonical booking detail link -->
          <tr>
            <td style="background-color: #ffffff; padding: 0 32px 20px; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0;">
                <tr><td style="background-color: #e7b83f; border-radius: 6px;"><a href="${safeUrl}" target="_blank" style="display: inline-block; padding: 12px 28px; color: #1f2937; text-decoration: none; font-weight: 700; font-size: 14px;">View Booking</a></td></tr>
              </table>
            </td>
          </tr>
`;
  return html.includes("<!-- Footer -->")
    ? html.replace("<!-- Footer -->", `${row}          <!-- Footer -->`)
    : `${html}${row}`;
}

/**
 * Rewrite built-in booking CTAs to the authorized canonical detail URL.
 * Public/non-login recipients lose only authenticated `/bookings` buttons;
 * bearer payment/respond/consent links use different paths and are untouched.
 */
export function applyBookingDetailLinkToBuiltInHtml(
  html: string,
  bookingUrl: string | null,
): string {
  if (!bookingUrl) return removeBookingButtons(html);

  const safeUrl = escapeHtml(
    sanitizeEmailHref(bookingUrl, { baseUrl: getAppBaseUrl(), sameOrigin: true }),
  );
  let next = html;
  let replaced = false;
  let match = findBookingHref(next);
  while (match) {
    // A booking-detail CTA can itself target an action on the page (for
    // example the member-guest consent card at `#consent`). Canonicalize only
    // the booking path; preserve the query/fragment suffix byte-for-byte.
    const suffix = match[1] ?? "";
    const replacement = `href="${safeUrl}${suffix}"`;
    next = `${next.slice(0, match.index)}${replacement}${next.slice(match.index + match[0].length)}`;
    replaced = true;
    match = findBookingHref(next, match.index + replacement.length);
  }
  return replaced ? next : appendBookingButton(next, bookingUrl);
}

/**
 * Finalize the rendered delivery copy without ever mutating stored override
 * source. An authorized override remains byte-for-byte unchanged; an
 * unauthorized override loses stale/admin-authored authenticated booking
 * hrefs and visible URL text at this last outbound boundary. Bearer consent
 * links remain intact.
 */
export function finalizeBookingEmailHtml(params: {
  html: string;
  bookingUrl: string | null;
  bookingScoped: boolean;
  bodyOverrideApplied: boolean;
}): string {
  if (!params.bookingScoped) return params.html;
  if (params.bodyOverrideApplied) {
    return params.bookingUrl ? params.html : removeBookingButtons(params.html);
  }
  return applyBookingDetailLinkToBuiltInHtml(params.html, params.bookingUrl);
}
