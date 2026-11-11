import { NextRequest, NextResponse } from "next/server";

import { getAuditRequestContext } from "@/lib/audit";
import { deletePasskey } from "@/lib/webauthn";

import { guardPasskeyRequest, passkeyJsonError, registrationAllowed } from "../guard";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardPasskeyRequest(request);
  if (!guard.ok) return guard.response;
  const refused = registrationAllowed(guard);
  if (refused) return refused;

  const { id } = await params;
  const result = await deletePasskey({
    memberId: guard.member.id,
    id,
    actor: { kind: "member", memberId: guard.member.id },
    request: getAuditRequestContext(request),
  });
  if (!result.ok) return passkeyJsonError(result.status, result.error);
  return NextResponse.json({ ok: true });
}
