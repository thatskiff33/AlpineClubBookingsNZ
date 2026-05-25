import { describe, expect, it, vi } from "vitest";
import {
  adminMemberFactory,
  adminSession,
  bookingFactory,
  bookingGuestFactory,
  familyGroupFactory,
  FULL_DELEGATE_METHODS,
  jsonRequest,
  lodgeSession,
  makeSession,
  memberCreditFactory,
  memberFactory,
  memberSession,
  mockDelegate,
  nextRequest,
  paymentFactory,
  paymentRefundFactory,
  READ_METHODS,
  routeParams,
  transactionShim,
  WRITE_METHODS,
  xeroContactFixture,
} from "@/lib/__tests__/helpers";

describe("test helpers", () => {
  describe("sessions", () => {
    it("returns an admin session with sensible defaults", () => {
      const session = adminSession();
      expect(session.user.role).toBe("ADMIN");
      expect(session.user.id).toBe("admin-1");
      expect(session.expires).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it("applies overrides to admin sessions", () => {
      const session = adminSession({ id: "admin-9" });
      expect(session.user.id).toBe("admin-9");
      expect(session.user.role).toBe("ADMIN");
    });

    it("returns member and lodge sessions with the correct role", () => {
      expect(memberSession().user.role).toBe("MEMBER");
      expect(lodgeSession().user.role).toBe("LODGE");
    });

    it("makeSession lets callers override individual fields", () => {
      const session = makeSession({ email: "custom@example.org" });
      expect(session.user.email).toBe("custom@example.org");
      expect(session.user.id).toBe("test-user");
    });
  });

  describe("request builders", () => {
    it("prepends localhost when given a path", () => {
      const req = nextRequest("/api/admin/foo?bar=1");
      expect(req.nextUrl.pathname).toBe("/api/admin/foo");
      expect(req.nextUrl.searchParams.get("bar")).toBe("1");
    });

    it("accepts absolute URLs unchanged", () => {
      const req = nextRequest("https://example.org/path");
      expect(req.nextUrl.origin).toBe("https://example.org");
    });

    it("jsonRequest serialises body and sets content-type", async () => {
      const req = jsonRequest("/api/admin/foo", { reason: "test" });
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = await req.json();
      expect(body).toEqual({ reason: "test" });
      expect(req.method).toBe("POST");
    });

    it("routeParams wraps a value in a Promise", async () => {
      const params = routeParams({ id: "abc" });
      await expect(params.params).resolves.toEqual({ id: "abc" });
    });
  });

  describe("domain factories", () => {
    it("memberFactory returns an active adult MEMBER by default", () => {
      const member = memberFactory();
      expect(member.role).toBe("MEMBER");
      expect(member.active).toBe(true);
      expect(member.canLogin).toBe(true);
      expect(member.ageTier).toBe("ADULT");
    });

    it("memberFactory applies overrides", () => {
      const member = memberFactory({ id: "m-9", active: false });
      expect(member.id).toBe("m-9");
      expect(member.active).toBe(false);
    });

    it("adminMemberFactory returns ADMIN role", () => {
      expect(adminMemberFactory().role).toBe("ADMIN");
    });

    it("bookingFactory returns a confirmed booking with matching prices", () => {
      const booking = bookingFactory();
      expect(booking.status).toBe("CONFIRMED");
      expect(booking.totalPriceCents).toBe(booking.finalPriceCents);
    });

    it("bookingGuestFactory references the default booking id", () => {
      expect(bookingGuestFactory().bookingId).toBe("booking-1");
    });

    it("paymentFactory and paymentRefundFactory return integer cents", () => {
      const payment = paymentFactory();
      const refund = paymentRefundFactory();
      expect(Number.isInteger(payment.amountCents)).toBe(true);
      expect(Number.isInteger(refund.amountCents)).toBe(true);
    });

    it("memberCreditFactory defaults to zero credit", () => {
      expect(memberCreditFactory().amountCents).toBe(0);
    });

    it("familyGroupFactory returns a named family group", () => {
      expect(familyGroupFactory().name).toBe("Test Family");
    });

    it("xeroContactFixture has a stable contact id and name", () => {
      const contact = xeroContactFixture();
      expect(contact.contactID).toBe("xero-contact-1");
      expect(contact.name).toBe("Test Member");
    });
  });

  describe("prisma-mocks", () => {
    it("mockDelegate seeds every passed method as a vi.fn", () => {
      const delegate = mockDelegate(READ_METHODS);
      delegate.findUnique.mockResolvedValue("ok");
      expect(typeof delegate.findUnique).toBe("function");
      expect(delegate.findMany.getMockName()).toMatch(/spy|jest|vi/i);
    });

    it("READ/WRITE/FULL_DELEGATE_METHODS expose common names", () => {
      expect(READ_METHODS).toContain("findMany");
      expect(WRITE_METHODS).toContain("update");
      expect(FULL_DELEGATE_METHODS).toContain("findMany");
      expect(FULL_DELEGATE_METHODS).toContain("update");
    });

    it("transactionShim forwards the same client", async () => {
      const client = { tag: "client" };
      const txRunner = transactionShim(client);
      const cb = vi.fn().mockResolvedValue("done");
      await txRunner(cb);
      expect(cb).toHaveBeenCalledWith(client);
    });
  });
});
