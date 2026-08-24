import sanitizeHtml from "sanitize-html";

/**
 * Sanitiser for message board post bodies (epic #2992).
 *
 * DELIBERATELY ITS OWN ALLOWLIST rather than a reuse of `page-content-html.ts`.
 * That one governs CMS pages an ADMIN authors; this one governs HTML any
 * MEMBER can submit, so it is narrower on purpose — no `svg`, no `details`, no
 * `iframe`-adjacent anything, and no raw `class`. Widening the CMS list to
 * cover this would have quietly given every board author the surface an admin
 * page has.
 *
 * NO IMPORT OF "server-only": the same allowlist runs in the browser to keep
 * the composer honest about what will survive, and again on the server, which
 * is the one that counts. A client-side sanitiser is a courtesy; the server
 * call is the control.
 */

/** Font families the composer offers. Anything else is dropped. */
export const POST_FONT_FAMILIES = [
  { label: "Default", value: "" },
  { label: "Sans serif", value: "sans-serif" },
  { label: "Serif", value: "serif" },
  { label: "Monospace", value: "monospace" },
] as const;

/** Sizes the composer offers, in points, matching the toolbar's dropdown. */
export const POST_FONT_SIZES = [10, 12, 14, 16, 20, 24, 32] as const;

/**
 * Colours the composer offers.
 *
 * AN ALLOWLIST, NOT A COLOUR PICKER, and that is a readability decision as much
 * as a security one: a free picker lets a member choose white on white, or a
 * value that vanishes against the dark-theme background. These are checked to
 * hold against both themes.
 */
export const POST_COLOURS = [
  { label: "Default", value: "" },
  // Black at the owner's request (24 Aug 2026). The one entry that does
  // NOT hold on the dark theme -- near-invisible against a dark card --
  // accepted knowingly; the club_message/server_message style hooks let a
  // club's theme CSS compensate if it bites.
  { label: "Black", value: "#000000" },
  { label: "Red", value: "#b42318" },
  { label: "Orange", value: "#b54708" },
  { label: "Green", value: "#067647" },
  { label: "Blue", value: "#175cd3" },
  { label: "Purple", value: "#6941c6" },
  { label: "Grey", value: "#475467" },
] as const;

const ALLOWED_COLOUR_VALUES = POST_COLOURS.map((c) => c.value).filter(Boolean);

/**
 * `sanitize-html` matches a style value against these regexes and drops the
 * declaration when none match. Every pattern is anchored: an unanchored one
 * would let `red; behavior:url(...)` through on the strength of the `red`.
 */
const ALLOWED_STYLES: sanitizeHtml.IOptions["allowedStyles"] = {
  "*": {
    // Only the seven offered colours, spelled exactly. A member cannot reach
    // for white-on-white or a value that disappears in one of the two themes.
    color: ALLOWED_COLOUR_VALUES.map(
      (hex) => new RegExp(`^${hex}$`, "i"),
    ),
    "font-size": [/^(10|12|14|16|20|24|32)pt$/],
    "font-family": [/^(sans-serif|serif|monospace)$/],
    "text-align": [/^(left|center|right|justify)$/],
  },
};

/**
 * The one place an `<img src>` may point.
 *
 * A board image is always one this deployment stored and serves behind a
 * session check. Restricting the shape to our own route is what stops a post
 * embedding a tracking pixel, silently making every reader's browser call a
 * third party, or referencing a file:// or data: payload.
 */
const IMAGE_SRC = /^\/api\/club-posts\/images\/[0-9a-f]{32}$/;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "h1",
    "h2",
    "h3",
    "ul",
    "ol",
    "li",
    "blockquote",
    "span",
    "div",
    "a",
    "img",
  ],
  allowedAttributes: {
    "*": ["style"],
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height"],
  },
  allowedStyles: ALLOWED_STYLES,
  // http/https only. Excluding `mailto` is deliberate: a board post asking
  // members to email an address can simply write it, and a live mailto is a
  // one-click way to harvest a reply-to from every reader.
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: { img: [] },
  transformTags: {
    // Every outbound link opens away from the board and cannot reach back into
    // it through `window.opener`.
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    }),
  },
  // Anything not on the list above loses its TAG but keeps its TEXT, so a post
  // that used something unsupported still reads as the member wrote it rather
  // than silently losing a sentence. `script` and `style` are the exceptions:
  // their text content is the danger, so it goes with them.
  nonTextTags: ["script", "style", "textarea", "option", "noscript"],
  exclusiveFilter: (frame) => {
    // Drop an image that does not point at our own serving route. Done here
    // rather than through allowedSchemes because the requirement is the exact
    // PATH shape, not merely a safe scheme.
    if (frame.tag === "img") {
      const src = frame.attribs?.src ?? "";
      return !IMAGE_SRC.test(src);
    }
    return false;
  },
};

/** Sanitise a post body. Returns "" when nothing survives. */
export function sanitiseClubPostHtml(input: string): string {
  if (typeof input !== "string" || input.trim() === "") return "";
  return sanitizeHtml(input, OPTIONS).trim();
}

/**
 * The plain-text form of a rich body.
 *
 * Used to fill `ClubPost.content`, which stays authoritative for search, the
 * dashboard card, the moderation list and any consumer that cannot render
 * HTML. Block boundaries become newlines so the text reads the way the post
 * looked rather than running every paragraph together.
 */
export function clubPostHtmlToText(html: string): string {
  if (typeof html !== "string" || html.trim() === "") return "";
  const withBreaks = html
    .replace(/<\/(p|div|h1|h2|h3|li|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return (
    text
      // sanitize-html leaves entities decoded; collapse the runs of blank lines
      // that block-boundary substitution creates.
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim()
  );
}

/** Every publicId an `<img>` in this body refers to. */
export function clubPostImageIds(html: string): string[] {
  const ids: string[] = [];
  const pattern = /\/api\/club-posts\/images\/([0-9a-f]{32})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}
