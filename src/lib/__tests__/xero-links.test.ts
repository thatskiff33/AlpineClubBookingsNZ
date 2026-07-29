import { describe, expect, it } from "vitest";
import {
  buildXeroContactUrl,
  buildXeroCreditNoteUrl,
  buildXeroDashboardUrl,
  buildXeroInvoiceUrl,
  buildXeroReportsUrl,
} from "@/lib/xero-links";

// #2261: the "Go to Xero" button in the Xero Sync page header. Both forms must
// be live URLs — the short code only makes the link land in the RIGHT
// organisation, its absence must never produce a dead link.
describe("buildXeroDashboardUrl", () => {
  it("links to the session-scoped Xero dashboard without a short code", () => {
    expect(buildXeroDashboardUrl()).toBe("https://go.xero.com/Dashboard/");
  });

  it("treats a null/empty short code as absent (fallback link)", () => {
    expect(buildXeroDashboardUrl({ shortCode: null })).toBe(
      "https://go.xero.com/Dashboard/"
    );
    expect(buildXeroDashboardUrl({ shortCode: "" })).toBe(
      "https://go.xero.com/Dashboard/"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroDashboardUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FDashboard%2F"
    );
  });
});

// #2283: every admin "open in Xero" link now flows through these object
// builders (enforced by xero-links-guard.test.ts), so their two contractual
// properties get pinned here. (1) A null/absent short code DEGRADES the link
// to the session-scoped classic path — never a dead new-app path, never a
// hidden link. (2) With a short code the link routes through Xero's
// organisation-login redirect, so an admin signed in to several Xero
// organisations lands in THIS club's books rather than whichever organisation
// their session last used.
describe("buildXeroContactUrl", () => {
  it("links to the session-scoped contact page without a short code", () => {
    expect(buildXeroContactUrl("contact-1")).toBe(
      "https://go.xero.com/Contacts/View/contact-1"
    );
    expect(buildXeroContactUrl("contact-1", { shortCode: null })).toBe(
      "https://go.xero.com/Contacts/View/contact-1"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroContactUrl("contact-1", { shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FContacts%2FView%2Fcontact-1"
    );
  });

  it("URL-encodes the contact id", () => {
    expect(buildXeroContactUrl("a/b c")).toBe(
      "https://go.xero.com/Contacts/View/a%2Fb%20c"
    );
  });
});

describe("buildXeroInvoiceUrl", () => {
  it("links to the session-scoped invoice page without a short code", () => {
    expect(buildXeroInvoiceUrl("inv-1")).toBe(
      "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1"
    );
    expect(buildXeroInvoiceUrl("inv-1", { shortCode: null })).toBe(
      "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroInvoiceUrl("inv-1", { shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FAccountsReceivable%2FView.aspx%3FInvoiceID%3Dinv-1"
    );
  });
});

describe("buildXeroCreditNoteUrl", () => {
  it("links to the session-scoped credit note page without a short code", () => {
    expect(buildXeroCreditNoteUrl("cn-1")).toBe(
      "https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=cn-1"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroCreditNoteUrl("cn-1", { shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FAccountsReceivable%2FViewCreditNote.aspx%3FcreditNoteID%3Dcn-1"
    );
  });
});

describe("buildXeroReportsUrl", () => {
  it("links to the session-scoped Xero report centre without a short code", () => {
    expect(buildXeroReportsUrl()).toBe("https://go.xero.com/Reports/");
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroReportsUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FReports%2F"
    );
  });
});
