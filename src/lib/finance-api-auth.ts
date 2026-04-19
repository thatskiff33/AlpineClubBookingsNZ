import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  hasFinanceManagerAccess,
  loadFinanceAccessMember,
  type FinanceAccessMember,
} from "@/lib/finance-auth";

type FinanceApiAuthSuccess = {
  ok: true;
  member: FinanceAccessMember;
};

type FinanceApiAuthFailure = {
  ok: false;
  response: NextResponse;
};

export type FinanceApiAuthResult =
  | FinanceApiAuthSuccess
  | FinanceApiAuthFailure;

export async function requireFinanceManagerApiAccess(): Promise<FinanceApiAuthResult> {
  const session = await auth();

  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }

  const member = await loadFinanceAccessMember(session.user.id);

  if (!member) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }

  if (!member.active) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Account is deactivated" },
        { status: 403 }
      ),
    };
  }

  if (member.forcePasswordChange) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Password change required" },
        { status: 403 }
      ),
    };
  }

  if (!hasFinanceManagerAccess(member.financeAccessLevel)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Finance manager access required" },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    member,
  };
}
