/**
 * The plural of the club's hut-leader label (#3976) — the ONE place any screen
 * builds it.
 *
 * The label (`ClubIdentity.hutLeaderLabel`, Admin → Appearance → Identity) is
 * meant to be singular — "Hut Leader", "Warden", "Custodian" — and screens used
 * to pluralise it by appending "s". A club that saved "Hut Leaders" then read
 * "Hut Leaderss" in the admin sidebar. This adds no "s" to a label that already
 * ends in one (case-insensitive), so a plural-looking label is left as typed.
 *
 * Client-safe on purpose: it sits beside the bootstrap identity in
 * `club-identity.ts` rather than inside the server-only resolver
 * (`club-identity-settings.ts`), because the components that render the plural
 * read the label from `useClubIdentity()` in the browser.
 */
export function pluralHutLeaderLabel(label: string): string {
  const singular = label.trim();
  return /s$/i.test(singular) ? singular : `${singular}s`;
}
