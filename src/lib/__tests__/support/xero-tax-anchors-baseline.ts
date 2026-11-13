import { vi } from "vitest";
import { BASELINE_XERO_TAX_RENDERING } from "@/lib/xero-tax-rendering";

/**
 * `@/lib/xero-tax-anchors` for a suite whose prisma is a double (#4632): every
 * document renders under the baseline treatment, so its payload is the one
 * the suite pinned before #4632. Mount it with
 * `vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"))`;
 * a case that needs another treatment sets it with `mockResolvedValueOnce`.
 */
export const resolveXeroTaxRendering = vi.fn(async () => BASELINE_XERO_TAX_RENDERING);
