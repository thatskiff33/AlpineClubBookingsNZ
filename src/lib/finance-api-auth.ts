import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  hasFinanceManagerAccess,
  hasFinanceViewerAccess,
} from "@/lib/admin-permissions";
import {
  loadFinanceAccessMember,
  type FinanceAccessMember,
} from "@/lib/finance-auth";
import { isTwoFactorSessionBlocked } from "@/lib/two-factor-gate";

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

async function requireFinanceApiAccess(input: {
  hasRequiredAccess: (member: FinanceAccessMember) => boolean;
  missingAccessMessage: string;
}): Promise<FinanceApiAuthResult> {
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

  if (
    isTwoFactorSessionBlocked({
      sessionUser: session.user,
      member,
    })
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Two-factor verification required" },
        { status: 403 },
      ),
    };
  }

  if (!input.hasRequiredAccess(member)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: input.missingAccessMessage },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    member,
  };
}

export async function requireFinanceViewerApiAccess(): Promise<FinanceApiAuthResult> {
  return requireFinanceApiAccess({
    hasRequiredAccess: (member) =>
      hasFinanceViewerAccess(member),
    missingAccessMessage: "Finance viewer access required",
  });
}

export async function requireFinanceManagerApiAccess(): Promise<FinanceApiAuthResult> {
  return requireFinanceApiAccess({
    hasRequiredAccess: (member) =>
      hasFinanceManagerAccess(member),
    missingAccessMessage: "Finance manager access required",
  });
}
