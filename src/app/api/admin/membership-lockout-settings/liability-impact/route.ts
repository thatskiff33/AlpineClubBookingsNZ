import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { CHOOSABLE_LIABILITY_AGE_SOURCES } from "@/lib/policies/subscription";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { buildSubscriptionLiabilityImpact } from "@/lib/subscription-liability-impact";

/**
 * A proposed subscription-liability rule (#5190): both answers, chosen, from
 * the values open for choice — exactly what the settings `PUT` would accept as
 * an opt-in, so the list can never preview a rule the club cannot save.
 */
const proposalSchema = z
  .object({
    requiredTypeAgeRule: z.enum(["ALWAYS_OWES", "AGE_TIER_EXEMPTS"]),
    liabilityAgeSource: z.enum(CHOOSABLE_LIABILITY_AGE_SOURCES),
  })
  .strict();

/**
 * Who a proposed liability rule would change, for the club's current season
 * (#5190). Read-only: it writes nothing and runs no clear-up. Membership view,
 * like the settings it previews. The unpaid invoice numbers in `noLongerOwing`
 * are finance data, so they are returned only to a caller who also holds
 * finance view (#5190 review); anyone else gets null and
 * `invoiceNumbersShown: false`.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsed = proposalSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const seasonYear = clubSeasonYear(await clubTimeZone());
  const impact = await buildSubscriptionLiabilityImpact(prisma, {
    seasonYear,
    proposed: parsed.data,
  });
  const invoiceNumbersShown = hasAdminAreaAccess(guard.session.user, {
    area: "finance",
    level: "view",
  });
  return NextResponse.json({
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
  });
}
