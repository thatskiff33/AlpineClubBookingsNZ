import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messages: vi.fn(),
  club: vi.fn(),
}));

vi.mock("@/lib/booking-message-settings", () => ({
  loadPublicBookingMessages: mocks.messages,
  buildBookingMessageGlobalData: mocks.club,
}));

import {
  bankTransferNoteHtml,
  bankTransferNoteText,
  loadBankTransferOffer,
  SAMPLE_BANK_TRANSFER_OFFER,
} from "@/lib/credit-release-bank-transfer";
import { sampleValue } from "@/lib/email-message-registry";

/*
  #4253 release 2, D6 (`INV-ADDPAY-049`): the bank-transfer offer on a request for credit used
  elsewhere. The club's account details are text the club writes; the reference is the invoice number.
*/
const KEY = "paymentRequest.bankTransfer.instructions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.club.mockResolvedValue({
    CLUB_NAME: "Test Club",
    CLUB_LODGE_NAME: "Test Lodge",
    BASE_URL: "https://example.test",
    SUPPORT_EMAIL: "support@example.test",
  });
  mocks.messages.mockResolvedValue({ [KEY]: "Pay Test Club, account 00-0000-0000000-00, quoting {{paymentReference}}." });
});

describe("loadBankTransferOffer", () => {
  it("renders the club's words with the invoice number as the reference", async () => {
    expect(await loadBankTransferOffer("INV-0042")).toEqual({
      instructions: "Pay Test Club, account 00-0000-0000000-00, quoting INV-0042.",
      reference: "INV-0042",
    });
  });

  it("offers nothing without an invoice number, and does not even read the settings", async () => {
    expect(await loadBankTransferOffer(null)).toBeNull();
    expect(await loadBankTransferOffer("  ")).toBeNull();
    expect(mocks.messages).not.toHaveBeenCalled();
  });

  it("offers nothing while the club has written no details", async () => {
    mocks.messages.mockResolvedValue({ [KEY]: "" });
    expect(await loadBankTransferOffer("INV-0042")).toBeNull();
    mocks.messages.mockResolvedValue({ [KEY]: "   \n " });
    expect(await loadBankTransferOffer("INV-0042")).toBeNull();
    mocks.messages.mockResolvedValue({});
    expect(await loadBankTransferOffer("INV-0042")).toBeNull();
  });

  it("offers nothing where the details render to nothing (only an unknown field)", async () => {
    mocks.messages.mockResolvedValue({ [KEY]: "{{notAField}}" });
    expect(await loadBankTransferOffer("INV-0042")).toBeNull();
  });
});

describe("bankTransferNoteText", () => {
  it("is nothing without an offer, so the email body keeps its shape", () => {
    expect(bankTransferNoteText(null)).toBe("");
  });

  it("names the reference, then the club's words, then leaves a blank line", () => {
    expect(bankTransferNoteText({ instructions: "Account 12", reference: "INV-1" })).toBe(
      "You can also pay by bank transfer. Use the payment reference INV-1.\nAccount 12\n\n",
    );
  });
});

describe("the offer's one spelling", () => {
  it("is shared by the plain-text note, the built-in paragraph and the editor's sample", () => {
    const offer = { instructions: "Account <12>", reference: "INV-1" };
    const lead = "You can also pay by bank transfer. Use the payment reference ";
    expect(bankTransferNoteText(offer).startsWith(`${lead}INV-1.`)).toBe(true);
    expect(bankTransferNoteHtml(offer)).toBe(`${lead}<strong>INV-1</strong>.<br>Account &lt;12&gt;`);
    expect(sampleValue("bankTransferNote")).toBe(bankTransferNoteText(SAMPLE_BANK_TRANSFER_OFFER));
  });
});
