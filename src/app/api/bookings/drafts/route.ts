import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { servingMcpConnection } from "@/lib/mcp-connection-request";
import { listMemberDraftSummaries } from "@/lib/member-draft-summary";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // ALP-653: an AI app connection is sent a narrow summary (no dietary,
  // consent or internal columns); the website's answer below is unchanged.
  if (await servingMcpConnection()) {
    return NextResponse.json({ drafts: await listMemberDraftSummaries(session.user.id, new Date()) });
  }

  const drafts = await prisma.booking.findMany({
    where: {
      memberId: session.user.id,
      deletedAt: null,
      status: "DRAFT",
      draftExpiresAt: { gt: new Date() },
    },
    include: {
      guests: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ drafts });
}
