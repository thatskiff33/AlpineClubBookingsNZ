import { NextRequest, NextResponse } from "next/server";
import { generateAdminPaymentInvoice } from "@/lib/admin-payment-invoice-service";
import { PAYMENT_INVOICE_GENERATED_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-money";
import { connectionJson } from "@/lib/mcp-connection-request";
import { recordIdParamsSchema } from "@/lib/route-id-params";
import { requireAdmin } from "@/lib/session-guards";

function forbiddenResponse() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * POST /api/admin/payments/[id]/generate-invoice
 * Generates a Xero invoice for a payment that doesn't have one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
    unauthenticatedResponse: forbiddenResponse,
    forbiddenResponse,
  });
  if (!guard.ok) return guard.response;

  const parsed = recordIdParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await generateAdminPaymentInvoice({
    paymentId: parsed.data.id,
    adminMemberId: guard.session.user.id,
  });
  return connectionJson(request, result.body, PAYMENT_INVOICE_GENERATED_CONNECTION_SHAPE, result.init);
}
