import { beforeEach, describe, expect, it, vi } from "vitest";

// Fork #43 — {{ical}} renders the ICON ROW inside admin override bodies too,
// via the renderer's per-render sentinel swap, without weakening the
// token-value escaping the rich path is built on. Members never see the raw
// calendar URLs; image-blocking clients see the three service names through
// alt text.

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

import {
  type EmailTemplateData,
  prepareEmailMessage,
} from "@/lib/email-message-renderer";

const ICAL_TEXT = [
  "Add this stay to your calendar",
  "Calendar file (.ics): https://example.org/api/booking-calendar/bk1?token=t&exp=1",
  "Google Calendar: https://calendar.google.com/calendar/render?action=TEMPLATE",
  "Outlook.com: https://outlook.live.com/calendar/0/deeplink/compose?rru=addevent",
].join("\n");

const ICAL_HTML =
  '<span>Add this stay to your calendar:</span><a href="https://example.org/api/booking-calendar/bk1?token=t&amp;exp=1" title="Calendar file"><img src="https://example.org/branding/calendar/ics.png" alt="Calendar file"></a><a href="https://calendar.google.com/x" title="Google Calendar"><img src="https://example.org/branding/calendar/google-calendar.png" alt="Google Calendar"></a><a href="https://outlook.live.com/x" title="Outlook.com"><img src="https://example.org/branding/calendar/outlook.png" alt="Outlook.com"></a>';

beforeEach(() => {
  vi.clearAllMocks();
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeName: "Example Club Lodge",
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  });
});

async function renderOverride(
  override: Record<string, unknown>,
  templateData: EmailTemplateData,
) {
  findUniqueMock.mockResolvedValue({
    templateName: "booking-confirmed",
    subject: null,
    bodyText: null,
    bodyHtml: null,
    updatedAt: new Date(),
    updatedByMemberId: null,
    ...override,
  });
  return prepareEmailMessage({
    templateName: "booking-confirmed",
    subject: "Subject",
    html: "<original-file-template/>",
    templateData,
  });
}

describe("{{ical}} in a PLAIN override body (fork #43)", () => {
  it("renders the icon row, never the raw URL lines", async () => {
    const prepared = await renderOverride(
      {
        bodyText:
          "Booking Confirmed\n\nHi {{firstName}}.\n\n{{ical}} click to add to your calendar.",
      },
      { firstName: "Sam", ical: ICAL_TEXT, icalHtml: ICAL_HTML },
    );
    expect(prepared.html).toContain('alt="Calendar file"');
    expect(prepared.html).toContain('alt="Google Calendar"');
    expect(prepared.html).toContain('alt="Outlook.com"');
    expect(prepared.html).toContain("/branding/calendar/ics.png");
    // The admin's own surrounding wording survives beside the row.
    expect(prepared.html).toContain("click to add to your calendar.");
    // The flat block's written-out URLs never reach the member.
    expect(prepared.html).not.toContain("Calendar file (.ics):");
    expect(prepared.html).not.toContain(
      "calendar/render?action=TEMPLATE</",
    );
  });

  it("falls back to the flat text when the sender supplied no icon row", async () => {
    const prepared = await renderOverride(
      { bodyText: "Booking Confirmed\n\nHi.\n\n{{ical}}" },
      { ical: ICAL_TEXT },
    );
    expect(prepared.html).toContain("Calendar file (.ics):");
    // No calendar icons render (the themed shell's logo <img> is unrelated).
    expect(prepared.html).not.toContain("/branding/calendar/");
  });

  it("renders nothing where {{ical}} sits when both forms are empty (unauthorized recipient)", async () => {
    const prepared = await renderOverride(
      { bodyText: "Booking Confirmed\n\nHi.\n\n{{ical}}" },
      { ical: "", icalHtml: "" },
    );
    expect(prepared.html).not.toContain("branding/calendar");
    expect(prepared.html).not.toContain("Add this stay");
  });
});

describe("{{ical}} in a RICH override body (fork #43)", () => {
  it("renders the icon row through the sanitised path, with value-escaping intact", async () => {
    const prepared = await renderOverride(
      {
        bodyHtml:
          "<h2>Booking Confirmed</h2><p>Hi <b>{{firstName}}</b></p><p>{{ical}}</p>",
      },
      {
        firstName: 'Sam <script>alert(1)</script>',
        ical: ICAL_TEXT,
        icalHtml: ICAL_HTML,
      },
    );
    expect(prepared.html).toContain('alt="Google Calendar"');
    expect(prepared.html).toContain("/branding/calendar/outlook.png");
    // Token-value escaping is untouched by the swap.
    expect(prepared.html).toContain("Sam &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(prepared.html).not.toContain("<script>");
    expect(prepared.html).not.toContain("Calendar file (.ics):");
  });

  it("a token VALUE cannot ride the swap — icalHtml never substitutes as a token", async () => {
    const prepared = await renderOverride(
      { bodyText: "Booking Confirmed\n\nHi.\n\n{{icalHtml}}{{ical}}" },
      { ical: ICAL_TEXT, icalHtml: ICAL_HTML },
    );
    // {{icalHtml}} is not in token-space: it renders as NOTHING, while
    // {{ical}} still swaps to the row.
    expect(prepared.html).toContain('alt="Calendar file"');
    const iconCount = prepared.html.split("/branding/calendar/ics.png").length - 1;
    expect(iconCount).toBe(1);
  });
});
