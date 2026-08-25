import { beforeEach, describe, expect, it, vi } from "vitest";

// Fork #38 — how a stored override chooses its body renderer on a SEND. The
// two directions that matter: a row with a rich body renders it (tokens
// substituted with escaped values), and a legacy row — bodyHtml null or
// absent from a pre-migration read — renders through the plain path
// byte-for-byte, so nothing saved before the feature changes.

const { findUniqueMock, loadLodgeSettingsMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  loadLodgeSettingsMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { emailTemplateOverride: { findUnique: findUniqueMock } },
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: loadLodgeSettingsMock,
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

import { prepareEmailMessage } from "@/lib/email-message-renderer";

const OVERRIDE_BASE = {
  templateName: "booking-confirmed",
  subject: null,
  bodyText: "Booking Confirmed\n\nHi {{firstName}}, see you soon.",
  bodyHtml: null as string | null,
  updatedAt: new Date(),
  updatedByMemberId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeName: "Example Club Lodge",
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  });
});

async function renderWith(override: Record<string, unknown> | null) {
  findUniqueMock.mockResolvedValue(override);
  return prepareEmailMessage({
    templateName: "booking-confirmed",
    subject: "Subject",
    html: "<original-file-template/>",
    templateData: { firstName: 'Sam <script>alert(1)</script>' },
  });
}

describe("prepareEmailMessage and the rich body", () => {
  it("renders a stored rich body with styled markup and ESCAPED token values", async () => {
    const prepared = await renderWith({
      ...OVERRIDE_BASE,
      bodyHtml: "<p>Hi <b>{{firstName}}</b>, <i>see you soon</i>.</p>",
    });
    expect(prepared.bodyOverrideApplied).toBe(true);
    expect(prepared.html).toContain("<i>see you soon</i>");
    expect(prepared.html).toContain("Hi <b>Sam &lt;script&gt;alert(1)&lt;/script&gt;</b>");
    expect(prepared.html).not.toContain("<script>");
  });

  it("renders a legacy row (bodyHtml null) through the plain path unchanged", async () => {
    const prepared = await renderWith(OVERRIDE_BASE);
    expect(prepared.bodyOverrideApplied).toBe(true);
    // The plain path's shape: escaped text inside the pre-wrap block, no
    // author markup anywhere.
    expect(prepared.html).toContain("Hi Sam &lt;script&gt;alert(1)&lt;/script&gt;, see you soon.");
    expect(prepared.html).not.toContain("<b>Sam");
  });

  it("treats a pre-migration row with NO bodyHtml field exactly like null", async () => {
    const { bodyHtml: _omitted, ...preMigrationRow } = OVERRIDE_BASE;
    const prepared = await renderWith(preMigrationRow);
    expect(prepared.bodyOverrideApplied).toBe(true);
    expect(prepared.html).toContain("Hi Sam &lt;script&gt;alert(1)&lt;/script&gt;, see you soon.");
  });
});
