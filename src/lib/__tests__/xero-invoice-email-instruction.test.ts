/**
 * The creation-time Xero-invoice-email instruction (#2929, MAD epic #2725).
 *
 * The module is four small functions over two string constants, and the reason
 * it is worth its own suite is that it is the ONLY door between what is stored
 * on an operation row and what the invoice path believes about it. Everything
 * downstream trusts this parse, so an unrecognised value being read as a
 * withhold (invoices silently stop reaching members) or as a send (the member
 * receives the email an officer chose to withhold) are both failures nothing
 * else would catch.
 */
import { describe, expect, it } from "vitest";
import {
  XERO_INVOICE_EMAIL_SEND,
  XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION,
  readXeroInvoiceEmailInstruction,
  xeroInvoiceEmailInstructionForNotifyChoice,
  xeroInvoiceEmailIsWithheldAtCreation,
} from "@/lib/xero-invoice-email-instruction";

describe("readXeroInvoiceEmailInstruction", () => {
  it("round-trips both values this application writes", () => {
    expect(readXeroInvoiceEmailInstruction(XERO_INVOICE_EMAIL_SEND)).toBe(
      XERO_INVOICE_EMAIL_SEND,
    );
    expect(
      readXeroInvoiceEmailInstruction(XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION),
    ).toBe(XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION);
  });

  it("reads NULL as no instruction — the honest state of every pre-#2929 row", () => {
    // Not "send" and not "withhold": nobody was asked. Every operation enqueued
    // before this feature existed, and every enqueuer that has no on-behalf
    // email choice to express, stores exactly this.
    expect(readXeroInvoiceEmailInstruction(null)).toBeNull();
    expect(readXeroInvoiceEmailInstruction(undefined)).toBeNull();
  });

  it("reads anything it does not recognise as no instruction, whatever shape it arrives in", () => {
    // The column is a plain TEXT, so nothing at the database level stops a
    // future writer, a hand-run UPDATE or a bad migration putting something
    // else there. None of it may become a withhold by accident.
    for (const value of [
      "",
      "send",
      "SEND ",
      "withheld_at_creation",
      "WITHHELD",
      "TRUE",
      0,
      1,
      true,
      false,
      {},
      [],
      { instruction: XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION },
    ]) {
      expect(readXeroInvoiceEmailInstruction(value)).toBeNull();
    }
  });

  it("is the only thing that can produce a withhold", () => {
    // Stated as a test because it is the safety property: an unrecognised value
    // cannot reach `xeroInvoiceEmailIsWithheldAtCreation` as a withhold, because
    // it cannot get past the parse at all.
    expect(
      xeroInvoiceEmailIsWithheldAtCreation(
        readXeroInvoiceEmailInstruction("withheld_at_creation"),
      ),
    ).toBe(false);
  });
});

describe("xeroInvoiceEmailInstructionForNotifyChoice", () => {
  it("turns the officer's answer into the instruction, recording BOTH answers", () => {
    expect(xeroInvoiceEmailInstructionForNotifyChoice(false)).toBe(
      XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION,
    );
    // Recorded rather than left absent, so an operator reading the row can tell
    // "the officer chose to send" from "nobody was asked", which is what the
    // fourteen other enqueuers store.
    expect(xeroInvoiceEmailInstructionForNotifyChoice(true)).toBe(
      XERO_INVOICE_EMAIL_SEND,
    );
  });

  it("round-trips through the reader, so what it writes is always readable back", () => {
    for (const notifyMember of [true, false]) {
      const written = xeroInvoiceEmailInstructionForNotifyChoice(notifyMember);
      expect(readXeroInvoiceEmailInstruction(written)).toBe(written);
      expect(xeroInvoiceEmailIsWithheldAtCreation(written)).toBe(!notifyMember);
    }
  });
});

describe("xeroInvoiceEmailIsWithheldAtCreation", () => {
  it("withholds on the withhold, and on nothing else", () => {
    expect(
      xeroInvoiceEmailIsWithheldAtCreation(
        XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION,
      ),
    ).toBe(true);
    expect(xeroInvoiceEmailIsWithheldAtCreation(XERO_INVOICE_EMAIL_SEND)).toBe(
      false,
    );
    // No instruction is NOT a withhold. Reversing this would stop every invoice
    // email the application has ever sent, on every path, at once.
    expect(xeroInvoiceEmailIsWithheldAtCreation(null)).toBe(false);
  });
});
