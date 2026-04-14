import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";

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

  const sub = await prisma.memberSubscription.findFirst({
    where: { memberId: session.user.id, seasonYear },
    select: subscriptionSelect,
  });

  const status = sub?.status ?? "NOT_INVOICED";

  return NextResponse.json({
    status,
    seasonDisplay,
    invoiceUrl: sub?.xeroOnlineInvoiceUrl ?? null,
    invoiceNumber: sub?.xeroInvoiceNumber ?? null,
  });
}
