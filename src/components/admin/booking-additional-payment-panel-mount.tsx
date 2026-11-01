"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * React can retain a hidden streamed page while hydrating its visible copy.
 * Mount the officer's action panel only in the hydrated tree, so the hidden
 * stream never contains a second chase/withdraw panel. The server component
 * still owns the owed check, permissions, amounts and club formatting.
 */
export function BookingAdditionalPaymentPanelMount({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return hydrated ? children : <p className="text-sm text-muted-foreground" role="status">Loading additional-payment controls…</p>;
}
