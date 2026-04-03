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
  }
}
