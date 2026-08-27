import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  buildInternetBankingPaymentOptionState,
  loadInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireActiveSessionUser } from "@/lib/session-guards";

export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const url = new URL(request.url);
  const checkInParam = url.searchParams.get("checkIn");
  if (checkInParam && !isDateOnlyString(checkInParam)) {
    return NextResponse.json(
      { error: "Invalid checkIn. Expected YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const [modules, internetBankingSettings, clubTodayDateOnly] =
    await Promise.all([
      loadEffectiveModuleFlags(),
      loadInternetBankingPaymentSettings(),
      // #3123 — the club's PERSISTED zone decides the Internet Banking cutoff
      // day this route quotes back to the payer. React-cached for the request,
      // so it costs nothing the render pass has not already paid.
      clubTodayDateOnlyInstant(),
    ]);
  const internetBankingEnabled =
    modules.xeroIntegration && modules.internetBankingPayments;
  const internetBanking = buildInternetBankingPaymentOptionState({
    moduleEnabled: internetBankingEnabled,
    xeroIntegrationEnabled: modules.xeroIntegration,
    internetBankingPaymentsEnabled: modules.internetBankingPayments,
    settings: internetBankingSettings,
    checkIn: checkInParam ? parseDateOnly(checkInParam) : null,
    today: clubTodayDateOnly,
  });

  return NextResponse.json({
    methods: {
      stripe: {
        enabled: true,
        default: true,
      },
      internetBanking,
    },
    // The booking wizard offers a "group trip" option; it needs the module
    // flag client-side and this is the flags-aware route it already calls.
    groupBookingsEnabled: modules.groupBookings,
  });
}
