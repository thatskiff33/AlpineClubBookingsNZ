import {
  committeeAssignmentOrderBy,
  publicCommitteeAssignmentSelect,
  serializePublicCommitteeAssignment,
} from "@/lib/committee";
import { COMMITTEE_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { connectionJson } from "@/lib/mcp-connection-request";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/committee
 * Public endpoint: returns published committee assignments with server-curated
 * contact metadata. Member email addresses are never selected or returned.
 * An AI app connection (`list_committee`, ALP-718) is sent names, roles and
 * descriptions only.
 */
export async function GET(request: Request) {
  const [assignments, settings] = await Promise.all([
    prisma.committeeAssignment.findMany({
      where: {
        isActive: true,
        published: true,
        committeeRole: { isActive: true },
        member: { active: true },
      },
      orderBy: committeeAssignmentOrderBy(),
      // A pathological backstop, not a display limit: 500 is far above any real
      // committee (typically <30), so it never trims a genuine roster — the
      // roster stays the exact set whose photos /api/members/[id]/photo serves
      // publicly (visibility must stay in lockstep). It only bounds a
      // misconfigured/hostile admin publishing an absurd number of assignments
      // on this unauthenticated public endpoint.
      take: 500,
      select: publicCommitteeAssignmentSelect,
    }),
    prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { committeePhotoDisplay: true },
    }),
  ]);

  // MP5 (#171): the club opts the public roster into photos (NONE default). When
  // disabled, no photo metadata is emitted at all.
  const photoDisplay = settings?.committeePhotoDisplay ?? "NONE";
  const includePhoto = photoDisplay !== "NONE";
  const members = assignments.map((assignment) =>
    serializePublicCommitteeAssignment(assignment, { includePhoto }),
  );

  return connectionJson(request, { members, photoDisplay }, COMMITTEE_CONNECTION_SHAPE);
}
