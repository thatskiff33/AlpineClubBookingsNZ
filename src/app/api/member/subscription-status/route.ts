import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { checkMembershipStatus, isXeroConnected } from "@/lib/xero";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const seasonYear = getSeasonYear(new Date());
  const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;

  const subscriptionSelect = {
    status: true,
    xeroInvoiceId: true,
    xeroInvoiceNumber: true,
    xeroOnlineInvoiceUrl: true,
  } as const;

  let sub = await prisma.memberSubscription.findFirst({
    where: { memberId: session.user.id, seasonYear },
    select: subscriptionSelect,
  });

  // Older subscription rows may be missing the online invoice URL even though
  // Xero has one. Refresh once on demand so the member can pay immediately.
  if (
    sub &&
    (sub.status === "UNPAID" || sub.status === "OVERDUE") &&
    sub.xeroInvoiceId &&
    !sub.xeroOnlineInvoiceUrl
  ) {
    try {
      if (await isXeroConnected()) {
        await checkMembershipStatus(session.user.id, seasonYear);
        sub = await prisma.memberSubscription.findFirst({
          where: { memberId: session.user.id, seasonYear },
          select: subscriptionSelect,
        });
      }
    } catch {
      // Non-critical: keep the local subscription status if Xero refresh fails.
    }
  }

  const status = sub?.status ?? "NOT_INVOICED";

  return NextResponse.json({
    status,
    seasonDisplay,
    invoiceUrl: sub?.xeroOnlineInvoiceUrl ?? null,
    invoiceNumber: sub?.xeroInvoiceNumber ?? null,
  });
}
