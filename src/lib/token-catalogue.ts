// Client-safe catalogue of the {{token}} placeholders supported by admin
// rich-text (HTML) content. This module is the single source of truth for
// token names, help copy, and syntax rules: the matching regexes in
// src/lib/page-content-embeds.ts and the admin token-help UI are both derived
// from it. Deliberately no "server-only" import and no server dependencies —
// client components import this directly.

/** Editor surfaces a token can be used in. */
export type TokenContextId =
  | "page-content-body"
  | "lodge-instructions"
  | "site-footer";

export type HtmlTokenDefinition = {
  /** Canonical lower-case token name, without braces. */
  token: string;
  /**
   * "embed" tokens are replaced with a structured component when the page
   * body renders; "text" tokens are replaced inline with an escaped string.
   */
  kind: "embed" | "text";
  /** Help copy shown to admins. */
  description: string;
  /** Canonical usage example, braces included. */
  example: string;
  /** Extra walkthrough help (for example the skifield data-hash steps). */
  notes?: string;
  /** True when the token meaningfully accepts a `{{token:parameter}}` value. */
  allowsParameter?: boolean;
  parameterExample?: string;
  /**
   * True when the legacy single-brace form ({token}) is still accepted by the
   * embed matcher. Photo tokens and text tokens require double braces.
   */
  allowsLegacySingleBrace: boolean;
  contexts: TokenContextId[];
};

// test seam
export const HTML_TOKEN_CATALOGUE: readonly HtmlTokenDefinition[] = [
  {
    token: "committee-members-cards",
    kind: "embed",
    description:
      "This will display cards in a grid with a committee member in each one.",
    example: "{{committee-members-cards}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "member-application-form",
    kind: "embed",
    description: "This will display the Membership application form.",
    example: "{{member-application-form}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "contact-form",
    kind: "embed",
    description:
      "This will display a contact us form where a user can send a message " +
      "to the club or to a published contactable committee assignment.",
    example: "{{contact-form}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "join-apply-form",
    kind: "embed",
    description: "This will display the Membership application form.",
    example: "{{join-apply-form}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "booking-requests",
    kind: "embed",
    description:
      "This will display the public booking-request form, where a non-member " +
      "can request a stay (or a price) without an account. Placing this token on " +
      "an ordinary page renders the form under that page's CSP nonce and analytics " +
      "posture; the dedicated /booking-requests page is the canonical " +
      "per-request-nonce, analytics-free entry point.",
    example: "{{booking-requests}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "school-bookings",
    kind: "embed",
    description:
      "This will display the public school-group booking-request form, where a " +
      "school or group can request a stay and quote without an account. Placing " +
      "this token on an ordinary page renders the form under that page's CSP nonce " +
      "and analytics posture; the dedicated /school-bookings page is the canonical " +
      "per-request-nonce, analytics-free entry point.",
    example: "{{school-bookings}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "skifield-conditions",
    kind: "embed",
    description:
      "This will display the Ski resort status, weather, chairlift status, " +
      "road status.",
    example: "{{skifield-conditions}}",
    notes:
      "You will need to go to https://www.snow.nz/snow-report-widget and " +
      "select the skifield you want information on. On submit you will be " +
      "shown a script. On the first line, copy the hash code within the " +
      'quotes. e.g. data-hash="zzz". On this editor page do the following, ' +
      "while replacing zzz with your hashcode.",
    allowsParameter: true,
    parameterExample: "{{skifield-conditions:zzz}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "skifield-whakapapa",
    kind: "embed",
    description:
      "This will fetch the Whakapapa report and render road status, " +
      "conditions, and the Facilities, Food & Drink, and Lifts groups.",
    example: "{{skifield-whakapapa}}",
    allowsLegacySingleBrace: true,
    contexts: ["page-content-body"],
  },
  {
    token: "photo-gallery",
    kind: "embed",
    description:
      "This will display a PhotoSwipe gallery using the images already " +
      "inserted into the page body.",
    example: "{{photo-gallery}}",
    notes:
      "Add your images to the page body, then place the token where the " +
      "gallery should appear. You can also pass a folder path.",
    allowsParameter: true,
    parameterExample: "{{photo-gallery:/public/images/photos/One}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "photo-slideshow",
    kind: "embed",
    description:
      "This will display the same images in a slideshow-oriented PhotoSwipe " +
      "layout.",
    example: "{{photo-slideshow}}",
    notes:
      "Use the same folder-path format when you want to load all photos " +
      "from a directory.",
    allowsParameter: true,
    parameterExample: "{{photo-slideshow:/public/images/photos/One}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "hut-fees",
    kind: "embed",
    description: "Shows a nightly-rate table for each active hut season — age tiers down the side, one column per publicly listed membership type — for all lodges, or one named lodge.",
    example: "{{hut-fees}}",
    notes:
      "Membership types priced the same share one column, headed by their " +
      "names. Parameters are comma-separated key=value pairs after a colon; a " +
      "bare value is the lodge slug (back-compat). Keys: lodge=, type= (limits " +
      "the table to one membership type's column), group-by= (type splits the " +
      "season into one table per column; age transposes the table; joined with " +
      "+). by-age is shorthand for group-by=age. An unknown key or value shows " +
      "the empty state, never another group.",
    allowsParameter: true,
    parameterExample: "{{hut-fees:lodge=whakapapa, group-by=age}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "joining-fees",
    kind: "embed",
    description: "Lists the currently effective public joining fees, grouped by membership type or by age tier.",
    example: "{{joining-fees}}",
    notes:
      "Optional parameters (comma-separated key=value): type= limits to one " +
      "publicly-listed membership type; group-by=age (or by-age) groups by age " +
      "tier instead of by type. An unknown/unlisted type shows the empty state.",
    allowsParameter: true,
    parameterExample: "{{joining-fees:group-by=age}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "annual-fees",
    kind: "embed",
    description: "Lists current annual membership fee totals for publicly-listed types. Requires the dedicated Annual membership fees visibility opt-in.",
    example: "{{annual-fees}}",
    notes:
      "Shows the fee total by default. Optional parameters (comma-separated " +
      "key=value): type= limits to one publicly-listed membership type; " +
      "components opts into the per-line breakdown. Gated by its own " +
      "double-opt-in, separate from joining fees.",
    allowsParameter: true,
    parameterExample: "{{annual-fees:components}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "first-year-costs",
    kind: "embed",
    description:
      "Shows what it costs to join: the current joining fee plus the first year's annual subscription, as one total per publicly-listed membership type and age tier. Requires both the Joining fees and Annual membership fees visibility opt-ins.",
    example: "{{first-year-costs}}",
    notes:
      "Totals are worked out from the same dated fee schedules the invoicing uses, so " +
      "they change by themselves when a schedule takes effect. A type with no annual fee " +
      "set is left out rather than shown at its joining fee alone. Optional parameter: " +
      "type= limits to one publicly-listed membership type.",
    allowsParameter: true,
    parameterExample: "{{first-year-costs:type=family}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "entrance-fees",
    kind: "embed",
    description: "Deprecated alias of {{joining-fees}} — renders identically. Prefer {{joining-fees}} in new content.",
    example: "{{entrance-fees}}",
    allowsParameter: true,
    parameterExample: "{{entrance-fees:group-by=age}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "membership-types",
    kind: "embed",
    description: "Deprecated alias of {{annual-fees}} — renders identically. Prefer {{annual-fees}} in new content.",
    example: "{{membership-types}}",
    allowsParameter: true,
    parameterExample: "{{membership-types:components}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "booking-policy-summary",
    kind: "embed",
    description: "Shows customer-facing booking periods, provisional holds, minimum stays, and enabled group discounts.",
    example: "{{booking-policy-summary}}",
    allowsParameter: true,
    parameterExample: "{{booking-policy-summary:lodge-slug}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "cancellation-policy",
    kind: "embed",
    description: "Shows the persisted club-wide cancellation policy, or the effective policy for one named lodge.",
    example: "{{cancellation-policy}}",
    allowsParameter: true,
    parameterExample: "{{cancellation-policy:lodge-slug}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "club-name",
    kind: "text",
    description:
      "Replaced with the current club name when the content renders.",
    example: "{{club-name}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "currency",
    kind: "text",
    description:
      "Replaced with the current currency code when the content renders.",
    example: "{{currency}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "lodge-capacity",
    kind: "text",
    description:
      "Replaced with the default lodge's capacity when the content renders. " +
      "With more than one lodge, name a lodge by its slug — " +
      "{{lodge-capacity:lodge-slug}} — to show that lodge's capacity; an " +
      "unknown slug falls back to the default lodge.",
    example: "{{lodge-capacity}}",
    allowsParameter: true,
    parameterExample: "{{lodge-capacity:whakapapa-river-lodge}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "lodge-name",
    kind: "text",
    description:
      "Replaced with the default lodge's name when the content renders. With " +
      "more than one lodge, name a lodge by its slug — {{lodge-name:lodge-slug}} " +
      "— to show that lodge's name; an unknown slug falls back to the default " +
      "lodge.",
    example: "{{lodge-name}}",
    allowsParameter: true,
    parameterExample: "{{lodge-name:whakapapa-river-lodge}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "lodge-address",
    kind: "text",
    description:
      "Replaced with the default lodge's address when the content renders " +
      "(nothing is shown when no address is set). With more than one lodge, " +
      "name a lodge by its slug — {{lodge-address:lodge-slug}} — to show that " +
      "lodge's address; an unknown slug falls back to the default lodge.",
    example: "{{lodge-address}}",
    allowsParameter: true,
    parameterExample: "{{lodge-address:whakapapa-river-lodge}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions", "site-footer"],
  },
  {
    token: "hut-leader",
    kind: "text",
    description:
      "Inserts the club's configured hut-leader role label (default " +
      '"Hut Leader"; some clubs set e.g. "Lodge Leader") when the content ' +
      "renders. It is the role name only, never a specific person's name. " +
      "Manage who currently holds the role under Admin > Hut Leaders. Use it " +
      "for headings or standalone references.",
    example: "{{hut-leader}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions"],
  },
  {
    token: "hut-leader-lower",
    kind: "text",
    description:
      'Lower-cased form of the configured hut-leader role label (default ' +
      '"hut leader") — the role name, never a specific person\'s name. ' +
      "Use it mid-sentence so the configured label reads naturally in prose.",
    example: "{{hut-leader-lower}}",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body", "lodge-instructions"],
  },
  {
    token: "email-log-retention",
    kind: "text",
    description: "Inserts the club's current email-log retention policy, including whether automatic deletion is switched on.",
    example: "Email logs: {{email-log-retention}}.",
    allowsLegacySingleBrace: false,
    contexts: ["page-content-body"],
  },
  {
    token: "facebook-url",
    kind: "text",
    description:
      "Replaced with the club's Facebook URL from the club configuration " +
      "(falling back to the public website URL when no Facebook link is " +
      "configured). Use it as a link address so the link follows the " +
      "configuration.",
    example: "{{facebook-url}}",
    allowsLegacySingleBrace: false,
    contexts: ["site-footer"],
  },
];

/** All tokens available in the given editor context, in catalogue order. */
export function tokensForContext(
  context: TokenContextId,
): HtmlTokenDefinition[] {
  return HTML_TOKEN_CATALOGUE.filter((definition) =>
    definition.contexts.includes(context),
  );
}

/** Names of every embed token (double-brace form always accepted). */
export function embedTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) => definition.kind === "embed",
  ).map((definition) => definition.token);
}

/** Embed tokens that still accept the legacy single-brace {token} form. */
export function legacySingleBraceTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) =>
      definition.kind === "embed" && definition.allowsLegacySingleBrace,
  ).map((definition) => definition.token);
}

/** Names of every inline text token. */
export function textTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) => definition.kind === "text",
  ).map((definition) => definition.token);
}

/**
 * Text tokens split by declared parameter support: only tokens with
 * `allowsParameter` accept a `{{token:parameter}}` form (currently the
 * multi-lodge {{lodge-capacity:lodge-slug}}); every other text token
 * matches bare only, preserving the no-parameters rule.
 */
export function parameterisedTextTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) => definition.kind === "text" && definition.allowsParameter,
  ).map((definition) => definition.token);
}

export function plainTextTokenNames(): string[] {
  return HTML_TOKEN_CATALOGUE.filter(
    (definition) => definition.kind === "text" && !definition.allowsParameter,
  ).map((definition) => definition.token);
}
