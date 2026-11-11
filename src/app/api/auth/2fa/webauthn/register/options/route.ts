import { NextRequest, NextResponse } from "next/server";

import { createPasskeyRegistrationOptions } from "@/lib/webauthn";

import { guardPasskeyRequest, passkeyJsonError, registrationAllowed } from "../../guard";

export async function POST(request: NextRequest) {
  const guard = await guardPasskeyRequest(request);
  if (!guard.ok) return guard.response;
  const refused = registrationAllowed(guard);
  if (refused) return refused;

  const result = await createPasskeyRegistrationOptions({
    memberId: guard.member.id,
    email: guard.member.email,
    displayName:
      `${guard.member.firstName} ${guard.member.lastName}`.trim() || guard.member.email,
  });
  if (!result.ok) return passkeyJsonError(result.status, result.error);
  return NextResponse.json(result.options);
}
