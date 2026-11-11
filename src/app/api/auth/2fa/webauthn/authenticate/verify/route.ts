import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { recordTwoFactorFailure } from "@/lib/two-factor";
import { markTwoFactorSessionVerified } from "@/lib/two-factor-api";
import { verifyPasskeyAssertion } from "@/lib/webauthn";

import { authenticationAllowed, guardPasskeyRequest, passkeyJsonError } from "../../guard";

const bodySchema = z.object({ response: z.unknown() }).strict();

export async function POST(request: NextRequest) {
  const guard = await guardPasskeyRequest(request);
  if (!guard.ok) return guard.response;
  const refused = authenticationAllowed(guard);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return passkeyJsonError(400, "Invalid JSON payload");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await verifyPasskeyAssertion(guard.member.id, parsed.data.response, {
    kind: "member",
    memberId: guard.member.id,
  });
  if (!result.ok) {
    await recordTwoFactorFailure(guard.member.id);
    return passkeyJsonError(result.status, result.error);
  }
  await markTwoFactorSessionVerified("PASSKEY");
  return NextResponse.json({ ok: true });
}
