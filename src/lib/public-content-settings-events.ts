/**
 * Cross-panel wiring for the stored public-content settings (#2352, second
 * review finding S2).
 *
 * `admin/page-content` renders two independent client panels in one tree:
 * `PageContentPanel` (pages, and now their Delete) and
 * `PublicContentSettingsPanel` (fee/policy visibility, the Book Now button, the
 * committee photo). The settings panel loads once on mount and never refetches,
 * and it posts its WHOLE settings object on save — so a delete that moves the
 * Book Now target left the sibling panel holding `bookNowTarget: "PAGE"` plus a
 * page id that no longer exists, and every later save in it failed with
 * `400 "The selected Book Now page is not published."` until the officer thought
 * to reload the page. Deterministic, not a race.
 *
 * A window event rather than a shared provider or `router.refresh()`: the two
 * panels are siblings with no common client ancestor to hold state, and
 * `router.refresh()` re-renders the server tree without touching either panel's
 * own fetched state. Same shape as `member-onboarding-events.ts` and the admin
 * command palette's event.
 */
export const PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT =
  "admin:public-content-settings-changed";

/**
 * Announce that the stored public-content settings were changed by something
 * other than the settings panel itself. Safe to call from any admin client
 * component.
 */
export function emitPublicContentSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT));
}
