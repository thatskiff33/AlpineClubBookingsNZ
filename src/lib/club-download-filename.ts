import { asciiSlug } from "@/lib/ascii-slug";

/**
 * The prefix used when nothing of the club's short name survives slugifying,
 * for example a short name written entirely in non-Latin script.
 */
export const CLUB_DOWNLOAD_FALLBACK_PREFIX = "club";

/**
 * The club-named start of every file the app hands a person to download
 * (`INV-CONFIG-001`): the club's short name from its identity settings, as a
 * lowercase ASCII slug, so a member of any club downloads `<club>-my-data-…`
 * rather than another club's initials. Callers pass the RESOLVED identity's
 * `shortName` (`getClubIdentity()` on the server, `useClubIdentity()` in the
 * browser), never `clubConfig`, which ignores what the club saved.
 */
export function clubDownloadPrefix(shortName: string): string {
  return asciiSlug(shortName, CLUB_DOWNLOAD_FALLBACK_PREFIX);
}

/** `<club-prefix>-<stem>.<extension>`, e.g. `mhsc-report-2026-07-01.csv`. */
export function clubDownloadFilename(
  shortName: string,
  stem: string,
  extension: string,
): string {
  return `${clubDownloadPrefix(shortName)}-${stem}.${extension}`;
}
