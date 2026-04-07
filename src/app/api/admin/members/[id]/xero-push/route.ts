import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrCreateXeroContact } from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

/**
 * POST /api/admin/members/[id]/xero-push
 * Create a new Xero contact for this member and link them.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, email: true, xeroContactId: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (member.xeroContactId) {
    return NextResponse.json({ error: "Member already linked to Xero" }, { status: 409 });
  }

  try {
    const xeroContactId = await findOrCreateXeroContact(id);

    await logAudit({
      action: "XERO_PUSH",
      memberId: session.user.id,
      targetId: id,
      details: `Created Xero contact ${xeroContactId}`,
    });

    logger.info({ memberId: id, xeroContactId }, "Pushed member to Xero as new contact");

    return NextResponse.json({
      xeroContactId,
      xeroLink: `https://go.xero.com/Contacts/View/${xeroContactId}`,
    });
  } catch (err) {
    logger.error({ err, memberId: id }, "Error pushing member to Xero");
    return NextResponse.json({ error: "Failed to create Xero contact" }, { status: 500 });
  }
}
