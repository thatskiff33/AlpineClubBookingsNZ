import { NextResponse } from "next/server";
import {
  MOCK_XERO_ORG_BASE_CURRENCY,
  MOCK_XERO_ORG_FINANCIAL_YEAR_END_MONTH,
  MOCK_XERO_ORG_NAME,
  MOCK_XERO_ORG_SHORT_CODE,
} from "@/lib/xero-mock-endpoint";
import { mockDisabledResponse } from "../_guard";

// Mock Xero organisation read (#2080). Backs the wizard step-3 "right org?"
// confirmation. Test-only; 404 in production.
export async function GET() {
  const disabled = mockDisabledResponse();
  if (disabled) return disabled;

  return NextResponse.json({
    name: MOCK_XERO_ORG_NAME,
    financialYearEndMonth: MOCK_XERO_ORG_FINANCIAL_YEAR_END_MONTH,
    shortCode: MOCK_XERO_ORG_SHORT_CODE,
    baseCurrency: MOCK_XERO_ORG_BASE_CURRENCY,
  });
}
