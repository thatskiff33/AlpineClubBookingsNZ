import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedXeroClient, withXeroRetry } from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";
import { z } from "zod";

const linkSchema = z.object({
  xeroContactId: z.string().min(1),
});

/**
 * POST /api/admin/members/[id]/xero-link
 * Link a member to an existing Xero contact.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, xeroContactId: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "xeroContactId is required" }, { status: 400 });
  }

  try {
    // Verify the Xero contact exists
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const contactRes = await withXeroRetry(
      () => xero.accountingApi.getContact(tenantId, parsed.data.xeroContactId),
      { context: `verifyContact(${parsed.data.xeroContactId})` }
    );
    const contact = contactRes.body.contacts?.[0];
    if (!contact) {
      return NextResponse.json({ error: "Xero contact not found" }, { status: 404 });
    }

    // Check if contact is already linked to another member
    const existingLink = await prisma.member.findFirst({
      where: { xeroContactId: parsed.data.xeroContactId, id: { not: id } },
      select: { firstName: true, lastName: true },
    });
    if (existingLink) {
      return NextResponse.json(
        { error: `This Xero contact is already linked to ${existingLink.firstName} ${existingLink.lastName}` },
        { status: 409 }
      );
    }

    await prisma.member.update({
      where: { id },
      data: { xeroContactId: parsed.data.xeroContactId },
    });

    await logAudit({
      action: "XERO_LINK",
      memberId: session.user.id,
      targetId: id,
      details: `Linked to Xero contact ${parsed.data.xeroContactId} (${contact.name})`,
    });

    logger.info({ memberId: id, xeroContactId: parsed.data.xeroContactId }, "Manually linked member to Xero contact");

    return NextResponse.json({
      xeroContactId: parsed.data.xeroContactId,
      contactName: contact.name,
    });
  } catch (err) {
    const xeroError = getXeroApiErrorInfo(err, "Failed to link to Xero contact");
    if (!xeroError.handled) {
      logger.error({ err, memberId: id }, "Error linking member to Xero contact");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
