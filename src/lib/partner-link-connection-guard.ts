/**
 * What an AI app connection may not do through `POST /api/members/partner-link`
 * (ALP-795, `INV-MCP-006`).
 *
 * A family member with no login of their own cannot confirm a partner
 * request, so declaring them forms the partnership at once
 * (`requestPartnerLink`'s one-step path). That is the member's own
 * declaration, made on the website, like confirming a request addressed to
 * them; a connection is refused it. A browser is never refused here.
 */
import "server-only";

import { NextResponse } from "next/server";

import { arrivesAsMcpConnection } from "@/lib/mcp-connection-request";
import { prisma } from "@/lib/prisma";

/** A 403 for a connection declaring a no-login family member, otherwise null. */
export async function refuseOneStepPartnerForConnection(
  request: Request,
  targetMemberId: string,
): Promise<NextResponse | null> {
  if (!arrivesAsMcpConnection(request)) return null;
  const target = await prisma.member.findUnique({
    where: { id: targetMemberId },
    select: { canLogin: true },
  });
  if (!target || target.canLogin) return null;
  return NextResponse.json(
    {
      error:
        "Declaring a family member without their own login as your partner confirms it at once, so it is done on the website.",
    },
    { status: 403 },
  );
}
