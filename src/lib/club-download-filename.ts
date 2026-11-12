import { slugifyText } from "@/lib/slug";

/** What a download holds; the middle part of its filename. */
type ClubDownloadKind = "report" | "members" | "my-data";

/**
 * #4986 (`INV-CONFIG-001`): every file the app hands a person to save is named
 * from the club's own short name, never one club's initials, and falls back to
 * a neutral `club-` prefix when nothing filename-safe survives the slug. The
 * club day is left out only where none is known (a client-side fallback).
 * Client safe.
 */
export function clubDownloadFilename(
  shortName: string,
  kind: ClubDownloadKind,
  clubDay: string | null,
  extension: "csv" | "pdf" | "json",
): string {
  const day = clubDay === null ? "" : `-${clubDay}`;
  return `${slugifyText(shortName) || "club"}-${kind}${day}.${extension}`;
}
