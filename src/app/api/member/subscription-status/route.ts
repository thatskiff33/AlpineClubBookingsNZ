import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { requiresPaidSubscriptionForAgeTierFromSettings } from "@/lib/member-subscription-eligibility";

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

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      role: true,
      ageTier: true,
      subscriptions: {
        where: { seasonYear },
        select: subscriptionSelect,
        take: 1,
      },
    },
  });

  const sub = member?.subscriptions[0] ?? null;
  const subscriptionRequired =
    member?.role !== "ADMIN" &&
    await requiresPaidSubscriptionForAgeTierFromSettings(member?.ageTier);
  const status = sub?.status ?? "NOT_INVOICED";

  return NextResponse.json({
    status: subscriptionRequired ? status : "NOT_REQUIRED",
    seasonDisplay,
    invoiceUrl: subscriptionRequired ? sub?.xeroOnlineInvoiceUrl ?? null : null,
    invoiceNumber: subscriptionRequired ? sub?.xeroInvoiceNumber ?? null : null,
  });
}
