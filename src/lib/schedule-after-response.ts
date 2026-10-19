import "server-only";
import { after } from "next/server";

/** Register post-response work, with the same deferred fallback outside a request scope. */
export function scheduleAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}
