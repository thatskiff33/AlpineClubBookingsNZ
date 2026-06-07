import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireActiveSessionUser } from "@/lib/session-guards";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const modules = await loadEffectiveModuleFlags();
  const internetBankingEnabled =
    modules.xeroIntegration && modules.internetBankingPayments;

  return NextResponse.json({
    methods: {
      stripe: {
        enabled: true,
        default: true,
      },
      internetBanking: {
        enabled: internetBankingEnabled,
      },
    },
  });
}
