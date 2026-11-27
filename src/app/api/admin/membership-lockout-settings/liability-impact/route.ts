import { NextRequest, NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { clubToday } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { buildSubscriptionLiabilityImpact } from "@/lib/subscription-liability-impact";
import { liabilityImpactQuerySchema } from "@/lib/admin-membership-api/config-settings";
import { connectionJson } from "@/lib/mcp-connection-request";
import { LIABILITY_IMPACT_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-config";

/**
 * Who a proposed liability rule would change, for the club's current season
 * (#5190). Read-only: it writes nothing and runs no clear-up. Membership view,
 * like the settings it previews. The unpaid invoice numbers in `noLongerOwing`
 * are finance data, so they are returned only to a caller who also holds
 * finance view (#5190 review); anyone else gets null and
 * `invoiceNumbersShown: false`. Also the AI app action
 * `preview_subscription_liability_rule` (ALP-720), whose answer never carries
 * the invoice numbers.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsed = liabilityImpactQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const zone = await clubTimeZone();
  const seasonYear = clubSeasonYear(zone);
  const impact = await buildSubscriptionLiabilityImpact(prisma, {
    seasonYear,
    proposed: parsed.data,
    today: clubToday(zone),
  });
  const invoiceNumbersShown = hasAdminAreaAccess(guard.session.user, {
    area: "finance",
    level: "view",
  });
  return connectionJson(request, {
    impact: invoiceNumbersShown
      ? impact
      : {
          ...impact,
          noLongerOwing: impact.noLongerOwing.map((member) => ({
            ...member,
            unpaidInvoiceNumber: null,
          })),
        },
    invoiceNumbersShown,
  }, LIABILITY_IMPACT_CONNECTION_SHAPE);
}
