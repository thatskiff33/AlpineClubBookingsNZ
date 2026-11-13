import { slugifyText } from "@/lib/slug";

/**
 * #4986 (`INV-CONFIG-001`): the Reports CSV and PDF downloads are named from
 * the club's own short name, never one club's initials. Client safe.
 */
export function clubReportFilename(
  shortName: string,
  clubDay: string,
  extension: "csv" | "pdf",
): string {
  return `${slugifyText(shortName) || "club"}-report-${clubDay}.${extension}`;
}
