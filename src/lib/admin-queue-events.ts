/**
 * "An officer just decided something on a queue" (#4962). The sidebar's
 * Needs Attention badges live in the persistent admin layout, a separate
 * subtree from the queue pages, so a queue page announces a successful
 * decision with a window event and the sidebar refetches its counts — the badge
 * for the request just approved goes away without a reload.
 */
export const ADMIN_QUEUE_CHANGED_EVENT = "admin-queue-changed";

/** Announce a queue change; safe to call from any admin client component. */
export function notifyAdminQueueChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ADMIN_QUEUE_CHANGED_EVENT));
}
