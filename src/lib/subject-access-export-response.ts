import "server-only";

import type { ClubIdentity } from "@/config/club-identity-types";
import { clubTime } from "@/lib/club-time/server";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { slugify } from "@/lib/slug";

/** Which file: the member's own download, or the Full Admin's report about someone. */
export type SubjectAccessFileKind = "my-data" | "subject-access-report";

/**
 * The file name (#4915): the club's short name (else its name) as a
 * filesystem-safe slug, the kind, and the club's calendar day. Nothing in it
 * names the subject. With no usable club name it starts at the kind.
 */
export function subjectAccessExportFilename(
  identity: Pick<ClubIdentity, "shortName" | "name">,
  kind: SubjectAccessFileKind,
  clubDay: string,
): string {
  const club = slugify(identity.shortName) || slugify(identity.name);
  return `${[club, kind, clubDay].filter(Boolean).join("-")}.json`;
}

export async function subjectAccessExportResponse(
  payload: unknown,
  kind: SubjectAccessFileKind,
): Promise<Response> {
  const [club, identity] = await Promise.all([clubTime(), getClubIdentity()]);
  const filename = subjectAccessExportFilename(identity, kind, club.today());
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
