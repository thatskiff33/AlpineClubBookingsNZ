/**
 * Next.js instrumentation hook.
 * Runs once when the server starts.
 * Used to schedule cron jobs for auto-confirming pending bookings.
 */
export async function register() {
  // Only run cron in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = await import("node-cron");

    // Run every 3 hours to check for pending bookings past their hold deadline
    cron.default.schedule("0 */3 * * *", async () => {
      console.log("[CRON] Checking pending bookings for auto-confirmation...");
      try {
        const { confirmPendingBookings } = await import(
          "./lib/cron-confirm-pending"
        );
        const result = await confirmPendingBookings();
        console.log("[CRON] Pending booking confirmation complete:", {
          confirmed: result.confirmedBookingIds.length,
          bumped: result.bumpedBookingIds.length,
          failed: result.failedBookingIds.length,
        });
      } catch (err) {
        console.error("[CRON] Error in pending booking confirmation:", err);
      }
    });

    console.log("[CRON] Scheduled pending booking confirmation (every 3 hours)");

    // Run daily at 2 AM to refresh Xero membership statuses
    cron.default.schedule("0 2 * * *", async () => {
      console.log("[CRON] Refreshing Xero membership statuses...");
      try {
        const { isXeroConnected, refreshAllMembershipStatuses } = await import(
          "./lib/xero"
        );
        if (!(await isXeroConnected())) {
          console.log("[CRON] Xero not connected, skipping membership refresh");
          return;
        }
        const result = await refreshAllMembershipStatuses();
        console.log("[CRON] Xero membership refresh complete:", result);
      } catch (err) {
        console.error("[CRON] Error refreshing Xero memberships:", err);
      }
    });

    console.log("[CRON] Scheduled Xero membership refresh (daily at 2 AM)");
  }
}
