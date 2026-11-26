/**
 * Runs background work once the response has gone. Outside a request scope,
 * where Next.js `after` throws (scripts, some tests), the work runs on the
 * next microtask instead, so it is never dropped. Seven Xero routes each held
 * a copy of this until ALP-721 (`INV-SSOT`).
 */
import { after } from "next/server";

export function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}
