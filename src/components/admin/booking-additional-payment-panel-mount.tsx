"use client";

import type { ReactNode } from "react";
import { HydratedOnly } from "@/components/hydrated-only";

/**
 * React can retain a hidden streamed page while hydrating its visible copy.
 * Mount the officer's action panel only in the hydrated tree, so the hidden
 * stream never contains a second chase/withdraw panel. The server component
 * still owns the owed check, permissions, amounts and club formatting.
 */
export function BookingAdditionalPaymentPanelMount({ children }: { children: ReactNode }) {
  return <HydratedOnly fallback={<p className="text-sm text-muted-foreground" role="status">Loading additional-payment controls…</p>}>{children}</HydratedOnly>;
}
