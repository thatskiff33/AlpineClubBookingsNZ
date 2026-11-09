/**
 * The CLIENT-SAFE surface of the Google Analytics configuration (#2573).
 *
 * Deliberately free of `server-only`, Prisma, the logger and anything from
 * `next/` — this module is imported by the admin integration card and by the
 * public runtime, both `"use client"` components, as well as by the server
 * modules beside it (`analytics-settings.ts`, `analytics-privacy-policy.ts`) and
 * the admin write routes.
 *
 * It exists because the alternative does not build. A `"use client"` module that
 * imports a VALUE from a `server-only` module drags `import "server-only"` into
 * the client layer, and Next fails the build with "'server-only' cannot be
 * imported from a Client Component module" (`next-invalid-import-error-loader`,
 * `node_modules/next/dist/build/webpack-config.js`). Nothing else catches it:
 * lint, typecheck and knip are all clean on it, and `vitest.setup.ts` mocks
 * `server-only` away for every test, so only the build gate sees it — which is
 * exactly how the first cut of this card shipped two such imports.
 * `src/components/__tests__/client-server-only-boundary.test.ts` now fails on
 * one instead, in seconds rather than at the build gate.
 *
 * So the rule for this pair of files: a constant, label, type or interface that
 * BOTH layers need lives here; anything that reads the database or the
 * environment stays in the server module.
 */

/**
 * The suggested default banner message (owner decision section 11). Editable
 * plain text; an admin may replace it with any other plain-text wording.
 *
 * It is deliberately not the pre-#2573 hard-coded sentence: that one said nothing
 * about the visitor being able to change their mind later, and there now is a
 * public Analytics preferences control to point them at.
 */
export const DEFAULT_ANALYTICS_BANNER_MESSAGE =
  "We use optional Google Analytics to understand how this website is used. " +
  "Analytics runs only after you select Accept. You can change your choice " +
  "later in Analytics preferences.";

/** Plain-text banner message ceiling (issue body: "for example 500 characters"). */
export const ANALYTICS_BANNER_MESSAGE_MAX_LENGTH = 500;

export interface AnalyticsSettingsValues {
  /** Trimmed GA4 measurement ID, or null when the club has not entered one. */
  measurementId: string | null;
  consentBannerEnabled: boolean;
  /** Trimmed plain-text banner message. Never null: the default stands in. */
  bannerMessage: string;
  /** Visitor re-consent counter. Bumped only by the explicit admin action. */
  consentRevision: number;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

/**
 * The four card states the owner's decision names (section 1), plus the module-off
 * case which the Integrations page answers by not rendering the card at all.
 */
export type AnalyticsIntegrationStatus =
  | "setup_required"
  | "configured_with_banner"
  | "configured_without_banner"
  | "invalid_configuration";

export const ANALYTICS_STATUS_LABELS: Record<
  AnalyticsIntegrationStatus,
  string
> = {
  setup_required: "Setup required",
  configured_with_banner: "Configured with consent banner",
  configured_without_banner: "Configured without consent banner",
  invalid_configuration: "Invalid or incomplete configuration",
};

/**
 * What the PUBLIC runtime is given. `null` means "no analytics", and it is the
 * answer for module-off, no-measurement-ID, invalid-measurement-ID and
 * read-failure alike — the public site cannot tell those apart and must not
 * behave differently between them.
 *
 * Note what is NOT here: nothing about the admin who saved it, no timestamps, no
 * club identifiers. Only the values the banner, the preferences panel and the tag
 * need.
 */
export interface AnalyticsRuntimeConfig {
  measurementId: string;
  consentBannerEnabled: boolean;
  bannerMessage: string;
  consentRevision: number;
  /**
   * The club's canonical privacy-policy page, or `null` when there is no
   * published one (owner decision section 2 item 4, clarification 5).
   *
   * The visitor is being asked to make a privacy decision, so the banner and the
   * preferences panel link the policy at the point of the decision — the footer's
   * own Privacy Policy link is underneath the fixed banner while it is asking.
   * `null` when the page does not exist or is unpublished, because a consent
   * banner must not offer a link to a 404.
   */
  privacyPolicyPath: string | null;
}

export interface PrivacyPolicyPageState {
  /** A `PageContent` row exists for the canonical slug. */
  exists: boolean;
  /** …and it is published, so a visitor can actually read it. */
  published: boolean;
  /** Public path, for the "view it" link. */
  publicPath: string;
  /** Admin path, for the "edit it" link. */
  adminHref: string;
}
