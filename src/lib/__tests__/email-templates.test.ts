import { describe, it, expect, vi } from "vitest";
import {
  welcomeTemplate,
  passwordResetTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  choreRosterTemplate,
  hutLeaderAssignmentTemplate,
  adminDailyDigestTemplate,
  adminPendingDeadlineTemplate,
  adminIssueReportTemplate,
  adminRefundRequestTemplate,
  waitlistOfferTemplate,
} from "../email-templates";
import { getAppBaseUrl } from "../app-url";
import { formatNZDateTime } from "../nzst-date";

describe("email-templates", () => {
  describe("welcomeTemplate", () => {
    it("includes the member name", () => {
      const html = welcomeTemplate("Alice");
      expect(html).toContain("Alice");
    });

    it("includes login link", () => {
      const html = welcomeTemplate("Bob");
      expect(html).toContain("/login");
    });

    it("includes Tokoroa Alpine Club branding", () => {
      const html = welcomeTemplate("Test");
      expect(html).toContain("Tokoroa Alpine Club");
      expect(html).toContain("/branding/logo.png");
      expect(html).toContain("#ffcb05");
    });

    it("uses dark text on light table headers", () => {
      const html = adminDailyDigestTemplate({
        newBookings: 1,
        paymentFailures: 0,
        capacityWarnings: 0,
        bookingsBumped: 0,
        pendingDeadlines: 0,
        xeroErrors: 0,
        totalAlerts: 1,
      });

      expect(html).toContain("background-color: #d9d5c2; color: #2f2f2b;");
      expect(html).not.toContain("background-color: #d9d5c2; color: #ffcb05;");
    });

    it("produces valid HTML structure", () => {
      const html = welcomeTemplate("Test");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("</html>");
    });
  });

  describe("passwordResetTemplate", () => {
    it("includes the reset URL", () => {
      const html = passwordResetTemplate("https://example.com/reset?token=abc");
      expect(html).toContain("https://example.com/reset?token=abc");
    });

    it("mentions expiry time", () => {
      const html = passwordResetTemplate("https://example.com/reset");
      expect(html).toContain("1 hour");
    });
  });

  describe("bookingConfirmedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes booking details", () => {
      const html = bookingConfirmedTemplate("Alice", checkIn, checkOut, 3, 45000);
      expect(html).toContain("Alice");
      expect(html).toContain("3");
      expect(html).toContain("$450.00");
    });

    it("shows confirmed status", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("Booking Confirmed");
    });

    it("includes view booking link", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("/bookings");
    });
  });

  describe("bookingPendingTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");
    const holdUntil = new Date("2026-07-08T00:30:00Z");

    it("includes pending explanation", () => {
      const html = bookingPendingTemplate("Alice", checkIn, checkOut, 3, holdUntil);
      expect(html).toContain("Booking Pending");
      expect(html).toContain("non-member");
    });

    it("mentions card won't be charged", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain("only be charged when the booking is confirmed");
    });

    it("shows the exact NZ-local hold deadline", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain(formatNZDateTime(holdUntil));
    });
  });

  describe("bookingBumpedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes bumped explanation", () => {
      const html = bookingBumpedTemplate("Alice", checkIn, checkOut, 2);
      expect(html).toContain("bumped");
      expect(html).toContain("member demand");
    });

    it("clarifies no charge", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1);
      expect(html).toContain("not been charged");
    });

    it("includes rebook link", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1);
      expect(html).toContain("/book");
    });
  });

  describe("bookingCancelledTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("shows refund amount when applicable", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 25000);
      expect(html).toContain("$250.00");
      expect(html).toContain("refund");
    });

    it("shows no refund message when zero", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 0);
      expect(html).toContain("No refund was applicable");
    });
  });

  describe("choreRosterTemplate", () => {
    it("includes chore list", () => {
      const html = choreRosterTemplate("Bob", "2026-07-15", [
        { name: "Dishes", description: "Wash all dishes" },
        { name: "Sweep", description: null },
      ]);
      expect(html).toContain("Dishes");
      expect(html).toContain("Sweep");
      expect(html).toContain("Wash all dishes");
    });

    it("includes heater/fire safety reminder", () => {
      const html = choreRosterTemplate("Test", "2026-07-15", []);
      expect(html).toContain("heaters and fire");
    });
  });

  describe("hutLeaderAssignmentTemplate", () => {
    const startDate = new Date("2026-07-15");
    const endDate = new Date("2026-07-18");

    it("includes the hut leader PIN and lodge link", () => {
      const html = hutLeaderAssignmentTemplate({
        firstName: "Alice",
        startDate,
        endDate,
        pin: "123456",
      });

      expect(html).toContain("123456");
      expect(html).toContain("/lodge");
    });

    it("includes assignment responsibilities", () => {
      const html = hutLeaderAssignmentTemplate({
        firstName: "Alice",
        startDate,
        endDate,
        pin: "123456",
      });

      expect(html).toContain("arrivals");
      expect(html).toContain("roster");
    });
  });

  describe("time-sensitive templates", () => {
    it("uses NZ-local date-time formatting for admin pending deadlines", () => {
      const deadline = new Date("2026-04-14T09:15:00Z");
      const html = adminPendingDeadlineTemplate([
        {
          memberName: "Jane Doe",
          checkIn: new Date("2026-04-15"),
          checkOut: new Date("2026-04-17"),
          guestCount: 3,
          deadline,
          hoursRemaining: 20,
        },
      ]);

      expect(html).toContain(formatNZDateTime(deadline));
    });

    it("uses NZ-local date-time formatting for waitlist offer expiry", () => {
      const expiresAt = new Date("2026-07-10T05:45:00Z");
      const html = waitlistOfferTemplate(
        "Jane",
        new Date("2026-07-01"),
        new Date("2026-07-03"),
        2,
        expiresAt,
        "booking123"
      );

      expect(html).toContain(formatNZDateTime(expiresAt));
    });
  });

  describe("support contact config", () => {
    it("uses the shared support email instead of hard-coded copy", async () => {
      vi.resetModules();
      vi.stubEnv("EMAIL_FROM", "sender@example.com");
      vi.stubEnv("SUPPORT_EMAIL", "help@example.com");

      const { accountDeletionApprovedTemplate } = await import("../email-templates");
      const html = accountDeletionApprovedTemplate("Alice");

      expect(html).toContain("help@example.com");
      expect(html).not.toContain("support@tokoroa.org.nz");

      vi.unstubAllEnvs();
    });
  });

  describe("issue report and refund free-text rendering", () => {
    it("preserves line breaks in issue report descriptions without trusting external URLs", () => {
      const html = adminIssueReportTemplate({
        memberName: "Casey Member",
        memberEmail: "casey@example.com",
        pageUrl: "https://evil.example/phish",
        pageTitle: "Broken page",
        description: "Line 1\n<script>alert(1)</script>\nLine 3",
        issueReportUrl: `${getAppBaseUrl()}/admin/issue-reports?report=issue-1`,
        hasScreenshot: true,
      });

      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("Line 1\n&lt;script&gt;alert(1)&lt;/script&gt;\nLine 3");
      expect(html).not.toContain('href="https://evil.example/phish"');
      expect(html).toContain(`href="${getAppBaseUrl()}"`);
      expect(html).toContain("/admin/issue-reports?report=issue-1");
    });

    it("preserves line breaks in refund appeal reasons", () => {
      const html = adminRefundRequestTemplate({
        memberName: "Casey Member",
        bookingId: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        reason: "First line\nSecond line",
        requestedAmountCents: 2500,
        paidAmountCents: 5000,
        refundedAmountCents: 0,
      });

      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("First line\nSecond line");
    });
  });
});
