import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { resolveOrganiserBilling, resolveOrganiserXeroContact, ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE } from "@/lib/organiser-billing";

const contact = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xero-contacts", () => ({ findOrCreateXeroContact: contact }));
const group = vi.fn();
const db = { groupBooking: { findUnique: group } } as unknown as Prisma.TransactionClient;
const child = { id: "place", organiserSettled: true, parentBookingId: "organiser-booking", payment: { source: "INTERNET_BANKING" } };
const organiser = { id: "organiser", firstName: "Group", lastName: "Organiser", email: "organiser@example.test" };
beforeEach(() => {
  vi.clearAllMocks();
  group.mockResolvedValue({ organiserBookingId: child.parentBookingId, organiserMemberId: organiser.id, organiserMember: organiser,
    settlement: { id: "settlement", source: "INTERNET_BANKING", xeroInvoiceId: "combined" } });
  contact.mockResolvedValue("organiser-contact");
});
describe("organiser billing identity", () => {
  it.each([
    { ...child, organiserSettled: false },
    { ...child, parentBookingId: null },
    { ...child, payment: { source: "STRIPE" } },
    { ...child, payment: null },
  ])("does not redirect a booking outside organiser bank settlement", async (booking) => {
    expect(await resolveOrganiserBilling(db, booking)).toBeNull();
    expect(group).not.toHaveBeenCalled();
    expect(contact).not.toHaveBeenCalled();
  });
  it("uses the combined invoice and organiser, without resolving a contact inside the edit", async () => {
    const billing = await resolveOrganiserBilling(db, child);
    expect(billing).toEqual({ settlementId: "settlement", combinedInvoiceId: "combined", organiserBookingId: child.parentBookingId,
      organiserMemberId: "organiser", organiser, placeBookingId: "place" });
    expect(group).toHaveBeenCalledWith(expect.objectContaining({ where: { organiserBookingId: "organiser-booking" } }));
    expect(contact).not.toHaveBeenCalled();
    expect(await resolveOrganiserXeroContact(billing!, { repairExistingLink: true })).toBe("organiser-contact");
    expect(contact).toHaveBeenCalledWith("organiser", { repairExistingLink: true });
  });
  it.each([null, { settlement: null }, { settlement: { source: "INTERNET_BANKING", xeroInvoiceId: null } },
    { settlement: { source: "STRIPE", xeroInvoiceId: "wrong-source" } }])("refuses a missing or mismatched combined invoice", async (record) => {
    group.mockResolvedValue(record);
    await expect(resolveOrganiserBilling(db, child)).rejects.toThrow(ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE);
    expect(contact).not.toHaveBeenCalled();
  });
});
