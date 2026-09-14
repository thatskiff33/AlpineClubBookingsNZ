/**
 * "Which Xero contact statuses count as still-live" has ONE home (#3058,
 * `INV-SSOT`).
 *
 * The defect this pins is not hypothetical and it was not a race: three
 * readers of `XeroContactCache.contactStatus` each decided the question for
 * themselves, two as allowlists and one as a denylist, and the provider's own
 * enum already carried a value that made them disagree. `GDPRREQUEST` — a
 * contact somebody has asked Xero to erase — was refused by the two allowlists
 * and reported to a treasurer as "Active in Xero" by the denylist, on the same
 * admin page.
 */
import { describe, expect, it } from "vitest";
import { Contact } from "xero-node";

import {
  ACTIVE_XERO_CONTACT_STATUS,
  classifyXeroContactStatus,
  isActiveXeroContactStatus,
  type XeroContactLiveness,
} from "@/lib/xero-contact-status";

describe("Xero contact status classification (#3058)", () => {
  it("recognises every value in the provider's own enum", () => {
    /*
      Read off `xero-node` rather than retyped, so a provider release that adds
      a status fails HERE — one assertion, naming the value — instead of
      silently joining whichever bucket a `default:` happened to be.
    */
    const providerStatuses = Object.values(Contact.ContactStatusEnum).filter(
      (value): value is string => typeof value === "string",
    );
    const unrecognised = providerStatuses.filter(
      (status) => classifyXeroContactStatus(status) === "UNRECOGNISED",
    );
    expect(
      unrecognised,
      "xero-node exposes a contact status this application does not classify. " +
        "Add it to classifyXeroContactStatus and decide, explicitly, whether the " +
        "erased-member review should list it or retire it (#3058).",
    ).toEqual([]);
  });

  it("tells the three known statuses apart", () => {
    expect(classifyXeroContactStatus("ACTIVE")).toBe("ACTIVE");
    expect(classifyXeroContactStatus("ARCHIVED")).toBe("ARCHIVED");
    expect(classifyXeroContactStatus("GDPRREQUEST")).toBe("GDPR_ERASED");
  });

  it("does not fold GDPRREQUEST into ACTIVE", () => {
    // The denylist reading — "anything that is not ARCHIVED is active" — is
    // exactly what this refuses. A contact somebody has asked Xero to erase is
    // the one row on the erased-member review most certainly needing no
    // further attention, and it was the one the panel called live.
    expect(classifyXeroContactStatus("GDPRREQUEST")).not.toBe("ACTIVE");
    expect(isActiveXeroContactStatus("GDPRREQUEST")).toBe(false);
  });

  it("reads the column's real shape: case, padding, empty and absent", () => {
    expect(classifyXeroContactStatus("  archived ")).toBe("ARCHIVED");
    expect(classifyXeroContactStatus("gdprrequest")).toBe("GDPR_ERASED");
    expect(classifyXeroContactStatus("")).toBe("UNRECOGNISED");
    expect(classifyXeroContactStatus("   ")).toBe("UNRECOGNISED");
    expect(classifyXeroContactStatus(null)).toBe("UNRECOGNISED");
    expect(classifyXeroContactStatus(undefined)).toBe("UNRECOGNISED");
  });

  it("treats an unknown status as not usable, never as usable", () => {
    const unknown: XeroContactLiveness =
      classifyXeroContactStatus("SOMETHING_XERO_ADDS_LATER");
    expect(unknown).toBe("UNRECOGNISED");
    expect(isActiveXeroContactStatus("SOMETHING_XERO_ADDS_LATER")).toBe(false);
  });

  it("gives the database filter and the predicate the same answer", () => {
    // The census filters SQL-side and cannot call the predicate, so the one
    // constant it uses must be a status the predicate also calls active.
    expect(isActiveXeroContactStatus(ACTIVE_XERO_CONTACT_STATUS)).toBe(true);
  });
});
