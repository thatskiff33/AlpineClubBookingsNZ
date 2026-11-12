import { NextRequest, NextResponse } from "next/server";

import { createPasskeyAuthenticationOptions } from "@/lib/webauthn";

import { authenticationAllowed, guardPasskeyRequest, passkeyJsonError } from "../../guard";

export async function POST(request: NextRequest) {
  const guard = await guardPasskeyRequest(request);
  if (!guard.ok) return guard.response;
  const refused = authenticationAllowed(guard);
  if (refused) return refused;

  const options = await createPasskeyAuthenticationOptions(guard.member.id);
  if (!options) {
    return passkeyJsonError(400, "No passkey is saved for this account.");
  }
  return NextResponse.json(options);
}
