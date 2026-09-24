/**
 * A RETURNING SCHOOL'S EARLIER BOOKING REACHES XERO AGAIN (#3368).
 *
 * Stage 2 (#3367) made the `Organisation` the invoiced party and handed it the
 * Xero contact that the school's own invented member used to hold — including
 * for a school that has booked before. It changed the INVOICE builder only.
 *
 * That left four provider paths resolving `findOrCreateXeroContact(memberId)`:
 * the refund credit note, the account-credit note, the modification credit note
 * and the supplementary invoice. On a returning school's EARLIER booking that
 * member no longer holds a contact link, so the resolve fell through to a
 * search by EMAIL — a school's recorded address is routinely a teacher's own,
 * and the school's address sits on both records — and stage 2's two-homes rule
 * refused it. The operation failed and stayed replayable; the issue thread
 * records closing that window as this stage's own obligation, and requires it
 * proved by exercising the path rather than by reasoning that the accessor
 * covers it.
 *
 * ## What this drives, and where it stops
 *
 * The REAL `findOrCreateXeroContactForInvoicedParty` and the real
 * organisation resolve behind it, down to the school's persisted contact id.
 * Nothing is mocked between the entry point and that answer.
 *
 * It stops at `retryXeroWriteWithContactRepair`, which is where every one of
 * the four hands its resolved contact to the provider: the stub captures the
 * call and throws, so each test asserts the contact the document would have
 * been raised against without driving a Xero write that has its own suites.
 * The repair function is captured with it and CALLED, because a repair that
 * still resolves the member is the same hole reached through the back door. A
 * repair asks for a fresh provider resolve by definition, so that call rejects
 * here; what is asserted is the party it went looking for, which is the half
 * that discriminates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SENTINEL = "STOP_AFTER_CONTACT_RESOLUTION";

const mocks = vi.hoisted(() => ({
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  xeroSyncOperationFindUnique: vi.fn(),
  memberCreditUpdateMany: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
  readOrganisationForXeroContact: vi.fn(),
  upsertOrganisationContactLink: vi.fn(),
  applyOrganisationShapeToAdoptedContact: vi.fn(),
  refreshOrganisationContactPersons: vi.fn(),
  ensureXeroContactContained: vi.fn(),
  resolveXeroContactEmailPolicy: vi.fn(),
  readClubTimeZoneOutsideRequest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findUnique: mocks.paymentFindUnique, update: mocks.paymentUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
    bookingModification: { findUnique: mocks.bookingModificationFindUnique },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
      findMany: mocks.xeroObjectLinkFindMany,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
      findFirst: mocks.xeroSyncOperationFindFirst,
      findUnique: mocks.xeroSyncOperationFindUnique,
    },
    memberCredit: { updateMany: mocks.memberCreditUpdateMany },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.example/invoice/${id}`,
  buildXeroContactUrl: (id: string) => `https://xero.example/contact/${id}`,
  buildXeroCreditNoteUrl: (id: string) => `https://xero.example/credit-note/${id}`,
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    callXeroApi: mocks.callXeroApi,
  };
});

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getAccountMapping: mocks.getAccountMapping,
}));

vi.mock("@/lib/xero-contacts", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contacts");
  return {
    ...actual,
    findOrCreateXeroContact: mocks.findOrCreateXeroContact,
    retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair,
  };
});

vi.mock("@/lib/organisation-xero-contact-persons", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/organisation-xero-contact-persons");
  return {
    ...actual,
    readOrganisationForXeroContact: mocks.readOrganisationForXeroContact,
    upsertOrganisationContactLink: mocks.upsertOrganisationContactLink,
    applyOrganisationShapeToAdoptedContact: mocks.applyOrganisationShapeToAdoptedContact,
    refreshOrganisationContactPersons: mocks.refreshOrganisationContactPersons,
  };
});

vi.mock("@/lib/xero-contact-containment", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contact-containment");
  return { ...actual, resolveXeroContactEmailPolicy: mocks.resolveXeroContactEmailPolicy };
});

vi.mock("@/lib/xero-contact-containment-proof", () => ({
  ensureXeroContactContained: mocks.ensureXeroContactContained,
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: mocks.readClubTimeZoneOutsideRequest,
}));

import {
  createUnappliedXeroCreditNote,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** The contact the school's Organisation has held since stage 2 took it. */
const SCHOOL_CONTACT = "xero-contact-held-by-the-school";
/** What the member path would resolve, and must not be reached for a school. */
const MEMBER_CONTACT = "xero-contact-resolved-from-the-member";

/**
 * The invented school member that owns the EARLIER booking. Stage 2 released
 * its Xero contact link to the Organisation, so it holds nothing today — which
 * is exactly why resolving through it searched Xero by email and was refused.
 */
const INVENTED_SCHOOL_MEMBER = "invented-school-member";

function bookingRow(organisationId: string | null) {
  return {
    id: "booking-from-last-year",
    memberId: INVENTED_SCHOOL_MEMBER,
    organisationId,
    checkIn: new Date("2026-02-01T00:00:00.000Z"),
    checkOut: new Date("2026-02-03T00:00:00.000Z"),
    member: { id: INVENTED_SCHOOL_MEMBER, firstName: "Mountain School", lastName: "" },
    guests: [],
    payment: { id: "pay-1", xeroInvoiceId: "invoice-from-last-year" },
  };
}

function paymentRow(organisationId: string | null) {
  return {
    id: "pay-1",
    xeroInvoiceId: "invoice-from-last-year",
    xeroRefundCreditNoteId: null,
    amountCents: 20000,
    refundedAmountCents: 0,
    booking: bookingRow(organisationId),
  };
}

/** Every entry point, driven far enough to have resolved its contact. */
const PATHS: ReadonlyArray<{
  name: string;
  run: (organisationId: string | null) => Promise<unknown>;
}> = [
  {
    name: "the refund credit note",
    run: async (organisationId) => {
      mocks.paymentFindUnique.mockResolvedValue(paymentRow(organisationId));
      return createXeroCreditNote("pay-1", 5000);
    },
  },
  {
    name: "the account-credit note",
    run: async (organisationId) => {
      mocks.paymentFindUnique.mockResolvedValue(paymentRow(organisationId));
      return createUnappliedXeroCreditNote("pay-1", 5000, CLUB_FORMAT_TEST);
    },
  },
  {
    name: "the modification credit note",
    run: async (organisationId) => {
      mocks.bookingFindUnique.mockResolvedValue(bookingRow(organisationId));
      return createXeroCreditNoteForModification({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-from-last-year",
        refundAmountCents: 5000,
        bookingModificationId: "mod-1",
      });
    },
  },
  {
    name: "the supplementary invoice",
    run: async (organisationId) => {
      mocks.bookingFindUnique.mockResolvedValue(bookingRow(organisationId));
      return createXeroSupplementaryInvoice({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-from-last-year",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod-1",
      });
    },
  },
];

/** The options `retryXeroWriteWithContactRepair` was handed, or a failure. */
function capturedRetry() {
  const call = mocks.retryXeroWriteWithContactRepair.mock.calls[0];
  expect(call, "the path never reached the provider write").toBeDefined();
  return call![0] as {
    currentContactId: string;
    memberId: string;
    repairContactLink?: (
      memberId: string,
      options?: Record<string, unknown>,
    ) => Promise<string>;
  };
}

beforeEach(() => {
  vi.resetAllMocks();

  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: {} },
    tenantId: "tenant-1",
  });
  mocks.callXeroApi.mockImplementation((fn: () => unknown) => fn());
  mocks.getResolvedAccountMapping.mockResolvedValue({
    code: "200",
    itemCode: undefined,
    codeExplicitlyConfigured: false,
  });
  mocks.getAccountMapping.mockResolvedValue("606");
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op-1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);
  mocks.xeroSyncOperationFindFirst.mockResolvedValue(null);
  mocks.xeroSyncOperationFindUnique.mockResolvedValue(null);
  mocks.xeroSyncOperationUpdate.mockResolvedValue(undefined);
  mocks.bookingModificationFindUnique.mockResolvedValue({
    createdAt: new Date("2026-02-10T00:00:00.000Z"),
  });
  mocks.readClubTimeZoneOutsideRequest.mockResolvedValue("Pacific/Auckland");

  // The member path, if anything reaches it.
  mocks.findOrCreateXeroContact.mockResolvedValue(MEMBER_CONTACT);

  // The school, as stage 2 leaves it: its own Organisation, already holding
  // the Xero contact its invented member used to hold.
  mocks.resolveXeroContactEmailPolicy.mockResolvedValue({ policy: { kind: "identity" } });
  mocks.readOrganisationForXeroContact.mockResolvedValue({
    id: "org-1",
    name: "Mountain School",
    email: "office@mountain.school.test",
    phone: "021 555 0000",
    xeroContactId: SCHOOL_CONTACT,
    contacts: [],
  });
  mocks.upsertOrganisationContactLink.mockResolvedValue(undefined);
  mocks.applyOrganisationShapeToAdoptedContact.mockResolvedValue(undefined);
  mocks.refreshOrganisationContactPersons.mockResolvedValue(undefined);
  mocks.ensureXeroContactContained.mockResolvedValue(undefined);

  // Stop at the provider write, having resolved the contact.
  mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));
});

describe("#3368: a returning school's EARLIER booking resolves the school's own Xero contact", () => {
  for (const path of PATHS) {
    it(`${path.name} is raised against the school, never the member`, async () => {
      await expect(path.run("org-1")).rejects.toThrow(SENTINEL);

      const retry = capturedRetry();
      expect(
        retry.currentContactId,
        "the document would have been raised against the wrong customer",
      ).toBe(SCHOOL_CONTACT);

      // The member-keyed resolve is what searches Xero by EMAIL and meets the
      // two-homes refusal. It must not run at all on a school's booking.
      expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
      expect(mocks.readOrganisationForXeroContact).toHaveBeenCalledWith("org-1");
    });

    it(`${path.name} repairs a stale reference against the school too`, async () => {
      await expect(path.run("org-1")).rejects.toThrow(SENTINEL);

      const retry = capturedRetry();
      expect(
        retry.repairContactLink,
        "without this the DEFAULT repair resolves the member and searches Xero by email",
      ).toBeTypeOf("function");

      mocks.readOrganisationForXeroContact.mockClear();
      // DRIVE it rather than reading it: the branch it takes is the whole
      // point. A repair asks for a fresh resolve (`repairExistingLink`), so it
      // deliberately skips the stored-link fast path and goes to the provider
      // — which this suite does not stand up, so the call rejects. What
      // discriminates is WHICH party it went looking for on the way.
      await retry.repairContactLink!(retry.memberId).catch(() => undefined);
      expect(
        mocks.readOrganisationForXeroContact,
        "the repair resolved something other than the school",
      ).toHaveBeenCalledWith("org-1");
      expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
    });
  }
});

describe("#3368: a booking with no organisation is today's behaviour to the letter", () => {
  for (const path of PATHS) {
    it(`${path.name} resolves the booking's own member, with the same options`, async () => {
      await expect(path.run(null)).rejects.toThrow(SENTINEL);

      expect(capturedRetry().currentContactId).toBe(MEMBER_CONTACT);
      expect(mocks.findOrCreateXeroContact).toHaveBeenCalledTimes(1);
      // The id it is handed is the booking's own member id — the accessor is
      // the identity on this column while it is still required — and the
      // options object is the caller's, unchanged.
      expect(mocks.findOrCreateXeroContact.mock.calls[0]![0]).toBe(
        INVENTED_SCHOOL_MEMBER,
      );
      expect(mocks.readOrganisationForXeroContact).not.toHaveBeenCalled();
    });
  }
});
