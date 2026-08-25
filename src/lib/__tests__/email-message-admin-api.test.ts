import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  emailTemplateOverrideFindUnique: vi.fn(),
  emailTemplateOverrideUpsert: vi.fn(),
  emailTemplateOverrideFindMany: vi.fn(),
  emailTemplateOverrideDeleteMany: vi.fn(),
  emailMessageSettingFindUnique: vi.fn(),
  emailMessageSettingUpsert: vi.fn(),
  notificationDeliveryPolicyFindUnique: vi.fn(),
  notificationDeliveryPolicyUpsert: vi.fn(),
  notificationDeliveryPolicyFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
  auditLogFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailTemplateOverride: {
      findUnique: mocks.emailTemplateOverrideFindUnique,
      upsert: mocks.emailTemplateOverrideUpsert,
      findMany: mocks.emailTemplateOverrideFindMany,
      deleteMany: mocks.emailTemplateOverrideDeleteMany,
    },
    emailMessageSetting: {
      findUnique: mocks.emailMessageSettingFindUnique,
      upsert: mocks.emailMessageSettingUpsert,
    },
    notificationDeliveryPolicy: {
      findUnique: mocks.notificationDeliveryPolicyFindUnique,
      upsert: mocks.notificationDeliveryPolicyUpsert,
      findMany: mocks.notificationDeliveryPolicyFindMany,
    },
    auditLog: {
      create: mocks.auditLogCreate,
      findMany: mocks.auditLogFindMany,
    },
  },
}));

import {
  GET as getEmailTemplates,
  PUT as putEmailTemplate,
} from "@/app/api/admin/email-templates/route";
import { POST as previewEmailTemplate } from "@/app/api/admin/email-templates/preview/route";
import { POST as resetEmailTemplate } from "@/app/api/admin/email-templates/reset/route";
import { PUT as putEmailSettings } from "@/app/api/admin/email-settings/route";
import {
  GET as getDeliveryPolicies,
  PUT as putDeliveryPolicy,
} from "@/app/api/admin/notification-delivery-policies/route";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin email message APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.emailTemplateOverrideFindUnique.mockResolvedValue(null);
    mocks.emailTemplateOverrideUpsert.mockResolvedValue({
      id: "override-1",
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      updatedByMemberId: "admin-1",
    });
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([]);
    mocks.emailTemplateOverrideDeleteMany.mockResolvedValue({ count: 1 });
    mocks.emailMessageSettingFindUnique.mockResolvedValue(null);
    mocks.emailMessageSettingUpsert.mockImplementation(({ update }) =>
      Promise.resolve({
        id: "default",
        ...update,
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
      }),
    );
    mocks.notificationDeliveryPolicyFindUnique.mockResolvedValue(null);
    mocks.notificationDeliveryPolicyUpsert.mockResolvedValue({
      id: "policy-1",
      templateName: "admin-daily-digest",
      mode: "DISABLED",
      updatedByMemberId: "admin-1",
    });
    mocks.notificationDeliveryPolicyFindMany.mockResolvedValue([]);
    mocks.auditLogCreate.mockResolvedValue({});
    // No club has been through the #2269 annotation strip unless a test says so.
    mocks.auditLogFindMany.mockResolvedValue([]);
  });

  it("blocks non-admin users", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });

    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("blocks non-admin users from updating email settings", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });

    const response = await putEmailSettings(
      request("/api/admin/email-settings", { clubName: "Hacked Club" }),
    );

    expect(response.status).toBe(403);
    expect(mocks.emailMessageSettingUpsert).not.toHaveBeenCalled();
  });

  it("honors inactive-user blocking", async () => {
    mocks.requireActiveSessionUser.mockResolvedValue(
      new Response(JSON.stringify({ error: "Inactive user" }), { status: 403 }),
    );

    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("rejects unsafe email template edits", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset\npassword",
        bodyText: "<strong>Reset</strong> javascript:alert(1)",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid email template");
    expect(body.missingRequiredTokens).toContain("token");
    expect(body.unsafeLinks).toContain("javascript:alert(1)");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  // #2267 (owner decision on PR #2311): the promo explanation is required
  // content on the payment confirmation, and the rejection has to arrive at the
  // editor as something an admin can act on — the panel joins these issue
  // messages onto its error toast.
  it("rejects a booking-confirmed override that drops the promo explanation", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.missingRequiredTokens).toEqual(["promoSummary"]);
    expect(
      body.issues.map((issue: { message: string }) => issue.message).join(" "),
    ).toContain("must show members how a promo code changed their price");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("keeps saving a legacy booking-confirmed override that shows the promo its own way", async () => {
    // The pre-#2267 shipped default's promo lines: subtotal, a hand-written
    // "Discount ({{promoCode}}): -{{discount}}" row, then the total. Every
    // override a club saved from that default must keep re-saving.
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nDiscount ({{promoCode}}): -{{discount}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalled();
  });

  it("rejects override subjects containing the door code token", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "Door code {{doorCode}} - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid email template");
    expect(body.sensitiveSubjectTokens).toContain("doorCode");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      templateName: "chore-roster",
      subject: "Complete your chores: {{choreLink}}",
      bodyText:
        "Hi {{guestName}}, mark {{choreName}} complete: {{choreLink}}",
      sensitiveToken: "choreLink",
    },
    {
      templateName: "booking-request-quote",
      subject: "Respond to your quote: {{respondUrl}}",
      bodyText:
        "Respond here: {{BASE_URL}}/booking-requests/respond/{{token}}",
      sensitiveToken: "respondUrl",
    },
    {
      templateName: "nomination-request",
      subject: "Review this nomination: {{reviewUrl}}",
      bodyText:
        "Review {{applicantName}} here: {{BASE_URL}}/nominations/{{token}}",
      sensitiveToken: "reviewUrl",
    },
  ])(
    "rejects $templateName subjects containing $sensitiveToken",
    async ({ templateName, subject, bodyText, sensitiveToken }) => {
      const response = await putEmailTemplate(
        request("/api/admin/email-templates", {
          templateName,
          subject,
          bodyText,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid email template");
      expect(body.sensitiveSubjectTokens).toContain(sensitiveToken);
      expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
    },
  );

  it("saves booking-confirmed overrides with the door code only in the body", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("saves valid template edits and audit logs the change", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalledWith({
      where: { templateName: "password-reset" },
      create: expect.objectContaining({
        templateName: "password-reset",
        updatedByMemberId: "admin-1",
      }),
      update: expect.objectContaining({
        updatedByMemberId: "admin-1",
      }),
    });
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:support@example.org",
    "ftp://bookings.example.org",
  ])("rejects non-http public URLs: %s", async (publicUrl) => {
    const response = await putEmailSettings(
      request("/api/admin/email-settings", { publicUrl }),
    );

    expect(response.status).toBe(400);
    expect(mocks.emailMessageSettingUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["https://bookings.example.org///", "https://bookings.example.org"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("accepts and normalizes http public URLs", async (publicUrl, normalized) => {
    const response = await putEmailSettings(
      request("/api/admin/email-settings", { publicUrl }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailMessageSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          publicUrl: normalized,
        }),
        update: expect.objectContaining({
          publicUrl: normalized,
        }),
      }),
    );
  });

  it("saves club-field updates and audit logs the changed keys", async () => {
    const response = await putEmailSettings(
      request("/api/admin/email-settings", { clubName: "River Valley Club" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailMessageSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ clubName: "River Valley Club" }),
        update: expect.objectContaining({ clubName: "River Valley Club" }),
      }),
    );

    const auditPayload = mocks.auditLogCreate.mock.calls.at(-1)?.[0];
    expect(auditPayload.data.metadata.changedKeys).toEqual(["clubName"]);
  });

  it("rejects the retired lodge-identity fields", async () => {
    for (const field of [
      { lodgeName: "Ghost Lodge" },
      { lodgeTravelNote: "n/a" },
      { doorCode: "2468" },
    ]) {
      const response = await putEmailSettings(
        request("/api/admin/email-settings", field),
      );
      expect(response.status).toBe(400);
    }
    // Lodge identity now lives on the Lodge table; the strict settings schema
    // no longer accepts these keys, so nothing is persisted.
    expect(mocks.emailMessageSettingUpsert).not.toHaveBeenCalled();
  });

  it("reports stale template overrides without listing them as current templates", async () => {
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        templateName: "retired-template",
        subject: "Retired",
        bodyText: "Old content",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.templates.some((template: { key: string }) => template.key === "retired-template")).toBe(false);
    expect(
      body.templates.find((template: { key: string }) => template.key === "password-reset")
        .override.subject,
    ).toBe("Reset your password");
    expect(body.staleOverrideCount).toBe(1);
    expect(body.staleOverrides).toEqual([
      expect.objectContaining({ templateName: "retired-template" }),
    ]);
  });

  // #2320 review (MED-1): a saved override authored from the pre-#2268 editor
  // text still carries the "[only when …]" junk as literal recipient-facing
  // content. The GET names every such row so the panel can flag them without
  // an admin opening each template, and the PUT refuses to (re-)save one.
  it("flags saved overrides that still carry bracket authoring notes", async () => {
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        // A clean override is not flagged.
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        // The pre-sweep shape: junk in the body of a registered template.
        templateName: "pre-arrival-reminder",
        subject: "Pre-arrival Information",
        bodyText:
          "Hi {{firstName}}.\n\nDoor code: {{doorCode}} [only when a door code is set]",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        // A STALE row with junk is flagged too — an operator deciding what to
        // re-author needs to know the old text was carrying it.
        templateName: "refund-request-resolved",
        subject: "Refund Appeal Approved [only when approved]",
        bodyText: "Old combined body",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bracketAnnotationOverrides).toEqual([
      {
        templateName: "pre-arrival-reminder",
        annotations: ["[only when a door code is set]"],
      },
      {
        templateName: "refund-request-resolved",
        annotations: ["[only when approved]"],
      },
    ]);
  });

  it("names saved overrides that still use a token their template no longer offers", async () => {
    // #2307 review (M2). A token a template stopped supplying renders as
    // NOTHING — there is no conditional syntax and no error — so an override
    // written against an older default keeps sending with a hole in it.
    //
    // This fixture used to be the check-in reminder's {{guestFirstName}}
    // {{guestLastName}} pair. The #2269 review proved that was the wrong
    // example and, worse, a live false warning: that sender DELIBERATELY still
    // supplies both tokens so a club holding a pre-#2307 override keeps naming
    // its guests. They are now declared in EXTRA_TEMPLATE_TOKENS and are no
    // longer reported. A token the template genuinely does not offer — a door
    // code in a password reset — is the honest case.
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        // Current wording: not flagged.
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        templateName: "chore-roster",
        subject: "Chore Roster",
        bodyText: [
          "Hi {{guestName}}.",
          "",
          "{{choreListNote}}",
          "",
          "Door code: {{doorCode}}",
        ].join("\n"),
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.retiredTokenOverrides).toEqual([
      {
        templateName: "chore-roster",
        tokens: ["doorCode"],
      },
    ]);
  });

  it("does not flag an override that uses the token the template now offers", async () => {
    // The contrast case, so the test above is a statement about RETIRED tokens
    // rather than about the banner firing for every override.
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        templateName: "checkin-reminder",
        subject: "Check-in Reminder",
        bodyText: [
          "Hi {{firstName}}.",
          "",
          "Guest list:",
          "",
          "{{guestName}}",
        ].join("\n"),
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();
    expect(body.retiredTokenOverrides).toEqual([]);
  });

  // #2269 (F3): the advisory half. `staleContent` reports the plain FACT that a
  // saved copy differs from the built-in wording (which drives the diff view),
  // and separately the short list of things that are objectively wrong with it.
  // The whole design brief was "must not produce false 'you have drifted'
  // noise", so most of what follows is about the cases that must NOT flag.
  describe("staleContent", () => {
    const bookingConfirmedDefault = getEmailTemplateDefinition(
      "booking-confirmed",
    )!;

    function overrideRow(
      templateName: string,
      subject: string | null,
      bodyText: string | null,
    ) {
      return {
        templateName,
        subject,
        bodyText,
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      };
    }

    async function staleContentFor(templateName: string) {
      const response = await getEmailTemplates();
      const body = await response.json();
      return body.templates.find(
        (template: { key: string }) => template.key === templateName,
      ).staleContent;
    }

    it("is null for a template with no saved override", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([]);
      expect(await staleContentFor("booking-confirmed")).toBeNull();
    });

    it("reports no difference when the saved copy IS the current default", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          bookingConfirmedDefault.defaultSubject,
          bookingConfirmedDefault.defaultBody,
        ),
      ]);

      expect(await staleContentFor("booking-confirmed")).toEqual(
        expect.objectContaining({
          differsFromDefault: false,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: false,
          reasons: [],
        }),
      );
    });

    it("reports a difference WITHOUT a reason when a club rewrote the wording deliberately", async () => {
      // The central no-false-noise case. This club rewrote every sentence and
      // kept every piece of required information. That is what an override is
      // for, so it gets the diff affordance and nothing that reads as a
      // problem.
      //
      // It uses {{paymentOutcome}} rather than the older "Total Paid:
      // {{totalPaid}}" row, because that row really does render "Total Paid:"
      // on a booking where payment is still owing — see the dangling-line case
      // below. This fixture is about wording that is DIFFERENT, not wording
      // that is broken.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          "Kia ora — your hut is booked",
          "Kia ora {{firstName}}, your bunk is locked in.\n\n{{promoSummary}}{{paymentOutcome}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}\n\nRemember to sign the hut book.",
        ),
      ]);

      expect(await staleContentFor("booking-confirmed")).toEqual(
        expect.objectContaining({
          differsFromDefault: true,
          subjectDiffersFromDefault: true,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
        }),
      );
    });

    it("does not flag a legacy override that carries the required information its own way", async () => {
      // The pre-#2267 shipped shape: a hand-written "Discount
      // ({{promoCode}}): -{{discount}}" row and a hand-written "Door code:
      // {{doorCode}}" line. Both satisfy their requirement through
      // requiredTokenAlternatives, and a staleness check that ignored
      // alternatives would nag every club still on that wording — the exact
      // false positive the issue warns about.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          "See you soon",
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nDiscount ({{promoCode}}): -{{discount}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
        ),
      ]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.differsFromDefault).toBe(true);
      expect(staleContent.missingRequiredTokens).toEqual([]);
      expect(staleContent.reasons).not.toContain("missing_required_token");

      const response = await getEmailTemplates();
      expect((await response.json()).missingRequiredTokenOverrides).toEqual([]);

      // It IS flagged for something else, and rightly: those hand-written
      // money rows render "Subtotal:" and "Discount (): -" on a booking with
      // no promo code. That is the separate dangling-line rule below, not a
      // "you have drifted" nag about the wording itself.
      expect(staleContent.reasons).toContain("dangling_line");
    });

    it("flags a saved copy that no longer shows something the email must say", async () => {
      // This is the drift #2267 created and nothing surfaced: the override
      // shows a subtotal and a total with no explanation of the difference.
      // Such a row cannot even be re-saved today, and until now nothing told
      // the admin so.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          "See you soon",
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
        ),
      ]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).toContain("missing_required_token");
      expect(staleContent.missingRequiredTokens).toEqual(["promoSummary"]);

      const response = await getEmailTemplates();
      expect((await response.json()).missingRequiredTokenOverrides).toEqual([
        { templateName: "booking-confirmed", tokens: ["promoSummary"] },
      ]);
    });

    it("gathers the reasons #2320 already banners onto the template they belong to", async () => {
      // Same detectors, same verdicts — repeated per template so the editor can
      // say everything about the message you have open in one place, instead of
      // making you match names out of a list at the top of the page.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "checkin-reminder",
          "Check-in Reminder",
          "Hi {{firstName}}.\n\nGuest list:\n\n{{guestName}} [only when chores exist]",
        ),
      ]);

      const staleContent = await staleContentFor("checkin-reminder");
      expect(staleContent.reasons).toEqual(["bracket_annotation"]);
      expect(staleContent.bracketAnnotations).toEqual([
        "[only when chores exist]",
      ]);
    });

    it("does NOT call the still-supplied check-in guest tokens retired", async () => {
      // #2269 review, reproduced against the live sender. The check-in reminder
      // supplies {{guestFirstName}}/{{guestLastName}} deliberately, so that a
      // club holding a pre-#2307 override keeps naming its guests
      // (src/lib/email/booking.ts). The editor nevertheless told those clubs
      // the template "no longer supplies" them — both clauses false — and,
      // because a disallowed token makes the whole validation invalid, that
      // club could not re-save its template at all. The only remedy on offer
      // was Restore Default, which destroys the very wording the
      // back-compatibility exists to protect.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "checkin-reminder",
          "Check-in Reminder",
          "Hi {{firstName}}.\n\nGuest list:\n\n{{guestFirstName}} {{guestLastName}}",
        ),
      ]);

      const staleContent = await staleContentFor("checkin-reminder");
      expect(staleContent.retiredTokens).toEqual([]);
      expect(staleContent.reasons).toEqual([]);

      const response = await getEmailTemplates();
      expect((await response.json()).retiredTokenOverrides).toEqual([]);

      // And the save it was blocking now goes through.
      const saved = await putEmailTemplate(
        request("/api/admin/email-templates", {
          templateName: "checkin-reminder",
          subject: "Check-in Reminder",
          bodyText:
            "Hi {{firstName}}.\n\nGuest list:\n\n{{guestFirstName}} {{guestLastName}}",
        }),
      );
      expect(saved.status).toBe(200);
    });

    it("names the exact lines that go out as a bare label (#2269 CRITICAL)", async () => {
      // The reason this issue's own migration made urgent. The shipped default
      // padded "[only when discountCents > 0]" onto these money lines, and the
      // brackets were the ONLY thing telling an admin they were conditional.
      // Once the migration removes them the row keeps rendering
      // "Discount (): -" on an ordinary booking and "Discount (PEAK): -" on a
      // promo that RAISED the price — a member charged more, shown a
      // "Discount" line. That is #2267 word for word, and before this it
      // produced no warning at all.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          "Booking Confirmed",
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nDiscount ({{promoCode}}): -{{discount}}\nDiscount: -{{discount}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
        ),
      ]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).toContain("dangling_line");
      expect(staleContent.danglingLines).toEqual([
        "Subtotal:",
        "Discount (): -",
        "Discount: -",
        "Total Paid:",
      ]);
    });

    it("does not invent a dangling line for a token that is always supplied", async () => {
      // The no-false-noise half: {{firstName}} and {{checkIn}} are never empty,
      // so a label in front of one is not a finding.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          "Booking Confirmed",
          "Hi {{firstName}}.\n\nCheck-in: {{checkIn}}\nGuests: {{guestCount}}\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
        ),
      ]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.danglingLines).toEqual([]);
      expect(staleContent.reasons).not.toContain("dangling_line");
    });

    it("says something rather than nothing when a saved copy is unsaveable for some other reason", async () => {
      // reasons covers five of the validator's ten issue codes. A row that
      // trips one of the other five cannot be re-saved, and until now nothing
      // in the editor said why. A sensitive token in a subject is the
      // reachable case.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "pre-arrival-reminder",
          "Your door code is {{doorCode}}",
          null,
        ),
      ]);

      const staleContent = await staleContentFor("pre-arrival-reminder");
      expect(staleContent.reasons).toContain("invalid_content");
    });

    it("treats a blank stored value as 'use the built-in wording'", async () => {
      // A stored "" renders exactly like the default, so reporting it as a
      // difference and diffing the whole default as removed is false drift.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow("booking-confirmed", "", "   "),
      ]);

      expect(await staleContentFor("booking-confirmed")).toEqual(
        expect.objectContaining({
          differsFromDefault: false,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: false,
        }),
      );
    });

    it("treats a null field as 'use the built-in wording', not as a difference", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow("booking-confirmed", null, bookingConfirmedDefault.defaultBody),
      ]);

      expect(await staleContentFor("booking-confirmed")).toEqual(
        expect.objectContaining({
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: false,
          differsFromDefault: false,
        }),
      );
    });

    // ------------------------------------------------------------------
    // #2269 (second review) — the tokenless conditional line.
    //
    // dangling_line above is computed by RENDERING tokens, so it can only ever
    // see a line that HAS one. The shipped defaults also padded these notes
    // onto lines of pure prose, and for those lines the bracket itself was the
    // entire signal — strip it and the row goes from "bracket_annotation, with
    // a banner" to nothing at all. So the reason is derived from what the
    // migration REMOVED, read back out of the migration's own audit row.
    // ------------------------------------------------------------------
    const STRIP_SOURCE =
      "migration:20260801150000_strip_email_override_bracket_annotations";
    const STRIPPED_AT = new Date("2026-08-01T15:00:00.000Z");
    const PAID_LINE_BEFORE =
      "Hi {{firstName}}.\n\nPayment has been processed successfully. [only when the booking is already paid]\n\n{{paymentDueNote}}\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}";
    const PAID_LINE_AFTER =
      "Hi {{firstName}}.\n\nPayment has been processed successfully.\n\n{{paymentDueNote}}\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}";

    function stripAuditRow(overrides?: {
      newBody?: string | null;
      createdAt?: Date;
    }) {
      return {
        entityId: "booking-confirmed",
        createdAt: overrides?.createdAt ?? STRIPPED_AT,
        metadata: {
          templateName: "booking-confirmed",
          previousOverride: {
            subject: "Booking Confirmed",
            bodyText: PAID_LINE_BEFORE,
          },
          newOverride: {
            subject: "Booking Confirmed",
            bodyText:
              overrides?.newBody === undefined
                ? PAID_LINE_AFTER
                : overrides.newBody,
          },
          removedAnnotations: ["[only when the booking is already paid]"],
          source: STRIP_SOURCE,
        },
      };
    }

    function strippedOverrideRow(bodyText: string = PAID_LINE_AFTER) {
      return {
        templateName: "booking-confirmed",
        subject: "Booking Confirmed",
        bodyText,
        updatedAt: STRIPPED_AT,
        updatedByMemberId: "admin-1",
      };
    }

    it("names the prose line the strip left unconditional, which has no token for guard 4 to see", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        strippedOverrideRow(),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([stripAuditRow()]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).toContain("stripped_annotation");
      expect(staleContent.strippedAnnotations).toEqual([
        "[only when the booking is already paid]",
      ]);
      expect(staleContent.unconditionalLines).toEqual([
        "Payment has been processed successfully.",
      ]);
      // The line carries no {{token}} at all, so the dangling-line check —
      // the only other thing here looking at line shape — is silent on it.
      expect(staleContent.danglingLines).toEqual([]);
    });

    it("names the same rows at the top of the page, where the bracket banner used to name them", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        strippedOverrideRow(),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([stripAuditRow()]);

      const response = await getEmailTemplates();
      const body = await response.json();
      expect(body.strippedAnnotationOverrides).toEqual([
        {
          templateName: "booking-confirmed",
          annotations: ["[only when the booking is already paid]"],
          lines: ["Payment has been processed successfully."],
        },
      ]);
      // And the row is no longer raising the bracket banner, which is exactly
      // why it needs this one.
      expect(body.bracketAnnotationOverrides).toEqual([]);
    });

    it("reads the audit trail only for the migration that wrote it", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        strippedOverrideRow(),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([stripAuditRow()]);

      await getEmailTemplates();

      const args = mocks.auditLogFindMany.mock.calls.at(-1)?.[0];
      expect(args.where).toEqual(
        expect.objectContaining({
          action: "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
          entityType: "EmailTemplateOverride",
          metadata: { path: ["source"], equals: STRIP_SOURCE },
        }),
      );
    });

    it("stops naming a row once the admin has saved over it", async () => {
      // The acknowledgement. Saving is what clears this notice, and it has to
      // clear on a save that changed NOTHING as well — an admin who read the
      // lines and decided they were fine has dealt with it.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        {
          ...strippedOverrideRow(),
          updatedAt: new Date("2026-08-02T09:00:00.000Z"),
        },
      ]);
      mocks.auditLogFindMany.mockResolvedValue([stripAuditRow()]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).not.toContain("stripped_annotation");
      expect(staleContent.strippedAnnotations).toEqual([]);
    });

    it("stops naming a row whose wording no longer matches what the migration wrote", async () => {
      // The other half of the same test, for a clock that cannot be trusted to
      // order an app-written updatedAt against a database-written createdAt.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        strippedOverrideRow(
          "Hi {{firstName}}.\n\n{{paymentOutcome}}\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
        ),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([stripAuditRow()]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).not.toContain("stripped_annotation");
    });

    it("ignores an audit row that does not carry the shape the migration writes", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        strippedOverrideRow(),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([
        { entityId: "booking-confirmed", createdAt: STRIPPED_AT, metadata: null },
        {
          entityId: "booking-confirmed",
          createdAt: STRIPPED_AT,
          metadata: { source: STRIP_SOURCE, removedAnnotations: [] },
        },
      ]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).not.toContain("stripped_annotation");
    });

    it("does not quote a line whose note had the whole line to itself", async () => {
      // The strip takes that line away entirely, so nothing new is sent and
      // there is no line for an admin to re-read — but the row is still named,
      // because we rewrote it.
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        strippedOverrideRow(
          "Hi {{firstName}}.\n\nDoor code: {{doorCode}}\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}",
        ),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([
        {
          entityId: "booking-confirmed",
          createdAt: STRIPPED_AT,
          metadata: {
            previousOverride: {
              subject: "Booking Confirmed",
              bodyText:
                "Hi {{firstName}}.\n\nDoor code: {{doorCode}}\n[only when a door code is set]\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}",
            },
            newOverride: {
              subject: "Booking Confirmed",
              bodyText:
                "Hi {{firstName}}.\n\nDoor code: {{doorCode}}\n\n{{promoSummary}}{{CLUB_LODGE_TRAVEL_NOTE}}",
            },
            removedAnnotations: ["[only when a door code is set]"],
            source: STRIP_SOURCE,
          },
        },
      ]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).toContain("stripped_annotation");
      expect(staleContent.unconditionalLines).toEqual([]);
    });

    it("says nothing about a club the strip never touched", async () => {
      mocks.emailTemplateOverrideFindMany.mockResolvedValue([
        overrideRow(
          "booking-confirmed",
          bookingConfirmedDefault.defaultSubject,
          bookingConfirmedDefault.defaultBody,
        ),
      ]);
      mocks.auditLogFindMany.mockResolvedValue([]);

      const staleContent = await staleContentFor("booking-confirmed");
      expect(staleContent.reasons).toEqual([]);
      expect(staleContent.strippedAnnotations).toEqual([]);
      expect(staleContent.unconditionalLines).toEqual([]);
    });
  });

  it("refuses to save an override that still carries a bracket authoring note", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "pre-arrival-reminder",
        subject: "Pre-arrival Information",
        bodyText:
          "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}} [only when a door code is set]",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.bracketAnnotations).toEqual(["[only when a door code is set]"]);
    expect(
      body.issues.some(
        (issue: { code: string }) => issue.code === "bracket_annotation",
      ),
    ).toBe(true);
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("lists every registered template from the authoritative TypeScript registry", async () => {
    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.templates.map((template: { key: string }) => template.key),
    ).toEqual(EMAIL_TEMPLATE_DEFINITIONS.map((definition) => definition.key));
  });

  it("previews every registered template with its default content", async () => {
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      const response = await previewEmailTemplate(
        postRequest("/api/admin/email-templates/preview", {
          templateName: definition.key,
          subject: definition.defaultSubject,
          bodyText: definition.defaultBody,
        }),
      );

      expect(response.status, definition.key).toBe(200);
      const body = await response.json();
      expect(body.subject, definition.key).toBeTypeOf("string");
      expect(body.html, definition.key).toBeTypeOf("string");
    }
  });

  it("saves every registered template with its default content", async () => {
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      const response = await putEmailTemplate(
        request("/api/admin/email-templates", {
          templateName: definition.key,
          subject: definition.defaultSubject,
          bodyText: definition.defaultBody,
        }),
      );

      expect(response.status, definition.key).toBe(200);
    }

    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalledTimes(
      EMAIL_TEMPLATE_DEFINITIONS.length,
    );
  });

  // Fork #38: the rich body path through the same PUT.
  it("saves a rich body sanitised, with its derived text stored beside it", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "Booking Confirmed - {{CLUB_LODGE_NAME}}",
        bodyHtml:
          '<h2>Booking Confirmed</h2><p>Hi <b>{{firstName}}</b>!</p><p>{{promoSummary}}{{paymentOutcome}}</p><p>{{CLUB_LODGE_TRAVEL_NOTE}}</p><p>{{doorCodeNote}}</p><script>alert(1)</script>',
      }),
    );
    expect(response.status).toBe(200);
    const upsert = mocks.emailTemplateOverrideUpsert.mock.calls.at(-1)?.[0];
    expect(upsert.update.bodyHtml).toContain("<b>{{firstName}}</b>");
    expect(upsert.update.bodyHtml).not.toContain("<script>");
    expect(upsert.update.bodyText).toContain("Hi {{firstName}}!");
    expect(upsert.update.bodyText).not.toContain("<b>");
  });

  it("treats an EMPTIED rich body as no body at all — the default renders, not a blank email (review H1)", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "Booking Confirmed - {{CLUB_LODGE_NAME}}",
        // What Chrome leaves after select-all + Delete: markup, no text.
        bodyHtml: "<p><br /></p>",
      }),
    );
    expect(response.status).toBe(200);
    const upsert = mocks.emailTemplateOverrideUpsert.mock.calls.at(-1)?.[0];
    expect(upsert.update.bodyHtml).toBeNull();
    expect(upsert.update.bodyText).toBeNull();
  });

  it("refuses a rich body whose derived text exceeds the plain 10k cap — the column contract is path-independent", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "Booking Confirmed - {{CLUB_LODGE_NAME}}",
        bodyHtml: `<p>{{CLUB_LODGE_TRAVEL_NOTE}}{{doorCodeNote}}{{promoSummary}}{{paymentOutcome}}${"x".repeat(10_500)}</p>`,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body.issues)).toContain("body_too_long");
  });

  it("previews an EMPTIED rich body as the built-in default — exactly what a send would render (drift lens 6)", async () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    const previewResponse = await previewEmailTemplate(
      postRequest("/api/admin/email-templates/preview", {
        templateName: "booking-confirmed",
        subject: definition.defaultSubject,
        bodyHtml: "<p><br /></p>",
      }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    // The default body's own heading proves the fallback rendered.
    expect(preview.html).toContain("Booking Confirmed");
    expect(preview.html).toContain("How to get to the lodge");
  });

  it("a plain bodyText save clears any stored rich body, so it cannot be shadowed", async () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: definition.defaultSubject,
        bodyText: definition.defaultBody,
      }),
    );
    expect(response.status).toBe(200);
    const upsert = mocks.emailTemplateOverrideUpsert.mock.calls.at(-1)?.[0];
    expect(upsert.update.bodyHtml).toBeNull();
    expect(upsert.update.bodyText).toBe(definition.defaultBody);
  });

  it("resets every registered template", async () => {
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      const response = await resetEmailTemplate(
        postRequest("/api/admin/email-templates/reset", {
          templateName: definition.key,
        }),
      );

      expect(response.status, definition.key).toBe(200);
    }

    expect(mocks.emailTemplateOverrideDeleteMany.mock.calls).toEqual(
      EMAIL_TEMPLATE_DEFINITIONS.map((definition) => [
        { where: { templateName: definition.key } },
      ]),
    );
  });

  it("records the wording Restore Default destroys (#2269 review)", async () => {
    // One click, no undo, and this release points at it from three places. The
    // deleted subject and body used to exist nowhere afterwards, so a club that
    // reset by mistake had lost years of wording for good.
    //
    // IN FULL — see the archive-mode test below. The confirmation dialog and
    // docs/guides/email-messages.md both promise the audit log holds the
    // wording; the ordinary metadata sanitiser clips every string at 1000
    // characters, which would have made that promise false for most real
    // bodies.
    mocks.emailTemplateOverrideFindUnique.mockResolvedValue({
      id: "override-1",
      templateName: "booking-confirmed",
      subject: "Kia ora, your hut is booked",
      bodyText: "Years of the club own wording.",
      updatedByMemberId: "admin-9",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    });

    const response = await resetEmailTemplate(
      postRequest("/api/admin/email-templates/reset", {
        templateName: "booking-confirmed",
      }),
    );

    expect(response.status).toBe(200);
    const auditArgs = mocks.auditLogCreate.mock.calls.at(-1)?.[0];
    expect(auditArgs.data.action).toBe("EMAIL_TEMPLATE_OVERRIDE_RESET");
    expect(auditArgs.data.metadata).toEqual(
      expect.objectContaining({
        templateName: "booking-confirmed",
        deletedOverride: expect.objectContaining({
          subject: "Kia ora, your hut is booked",
          bodyText: "Years of the club own wording.",
          updatedByMemberId: "admin-9",
        }),
      }),
    );
  });

  it("records that wording IN FULL, not clipped at 1000 characters (#2269 second review)", async () => {
    // The measured failure. Audit metadata clips every string at 1000
    // characters, so a real 1748-character body was stored as 1014 characters
    // ending "[TRUNCATED]" — well inside the editor's own 10,000-character cap,
    // and exactly the "years of wording" case the confirmation dialog and
    // docs/guides/email-messages.md invoke when they say the audit log holds
    // the copy. The migration half of this change stores its before/after
    // verbatim because SQL bypasses the sanitiser; without this the two halves
    // disagreed about the same content.
    const longBody = `${"Kia ora e te whanau. ".repeat(87)}Nga mihi.`;
    expect(longBody.length).toBeGreaterThan(1_000);
    expect(longBody.length).toBeLessThanOrEqual(10_000);

    mocks.emailTemplateOverrideFindUnique.mockResolvedValue({
      id: "override-1",
      templateName: "booking-confirmed",
      subject: "Kia ora, your hut is booked",
      bodyText: longBody,
      updatedByMemberId: "admin-9",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    });

    const response = await resetEmailTemplate(
      postRequest("/api/admin/email-templates/reset", {
        templateName: "booking-confirmed",
      }),
    );

    expect(response.status).toBe(200);
    const metadata = mocks.auditLogCreate.mock.calls.at(-1)?.[0].data.metadata;
    expect(metadata.deletedOverride.bodyText).toBe(longBody);
    expect(metadata.deletedOverride.bodyText).not.toContain("[TRUNCATED]");
  });

  it("keeps a body at the editor's own 10,000-character cap whole, newlines and all", async () => {
    // JSON escaping can double a value made mostly of newlines, so the envelope
    // cap has to move with the string cap or the whole metadata object collapses
    // to a {_truncated} stub — which would lose MORE than truncation did.
    const longBody = "Kia ora.\n".repeat(1_111);
    expect(longBody.length).toBeLessThanOrEqual(10_000);

    mocks.emailTemplateOverrideFindUnique.mockResolvedValue({
      id: "override-1",
      templateName: "booking-confirmed",
      subject: "Kia ora, your hut is booked",
      bodyText: longBody,
      updatedByMemberId: "admin-9",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    });

    await resetEmailTemplate(
      postRequest("/api/admin/email-templates/reset", {
        templateName: "booking-confirmed",
      }),
    );

    const metadata = mocks.auditLogCreate.mock.calls.at(-1)?.[0].data.metadata;
    expect(metadata._truncated).toBeUndefined();
    expect(metadata.deletedOverride.bodyText).toBe(longBody);
  });

  it("still redacts a secret hidden inside the wording it archives", async () => {
    // Archive mode relaxes SIZE, never redaction. This repo has form: a
    // migration exists (20260710000100_redact_audit_log_door_codes) because
    // plaintext door codes reached audit metadata.
    const bodyWithSecret = `${"Kia ora e te whanau. ".repeat(87)}sk_live_ABCDEF1234567890`;

    mocks.emailTemplateOverrideFindUnique.mockResolvedValue({
      id: "override-1",
      templateName: "booking-confirmed",
      subject: "Kia ora, your hut is booked",
      bodyText: bodyWithSecret,
      updatedByMemberId: "admin-9",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    });

    await resetEmailTemplate(
      postRequest("/api/admin/email-templates/reset", {
        templateName: "booking-confirmed",
      }),
    );

    const metadata = mocks.auditLogCreate.mock.calls.at(-1)?.[0].data.metadata;
    expect(metadata.deletedOverride.bodyText).toBe("[REDACTED]");
  });

  it("masks a secret-shaped line even in the wording it archives, and says so", async () => {
    // The one honest caveat on "in full", pinned so it cannot surprise anybody
    // — and pinned at its REAL width, which is a whole line rather than a
    // fragment. The key-value redaction fires on template text shaped like
    // `password: value`, and the SHIPPED password-reset body is exactly that
    // shape ("Reset Password: {{BASE_URL}}/reset-password?token={{token}}"), so
    // the entire link line archives as "Reset Password=[REDACTED]". The
    // confirmation dialog and docs/guides/email-messages.md both say so, with
    // this same example.
    const passwordResetDefault = getEmailTemplateDefinition("password-reset")!;
    expect(passwordResetDefault.defaultBody).toContain(
      "Reset Password: {{BASE_URL}}/reset-password?token={{token}}",
    );

    mocks.emailTemplateOverrideFindUnique.mockResolvedValue({
      id: "override-1",
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: passwordResetDefault.defaultBody,
      updatedByMemberId: "admin-9",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    });

    await resetEmailTemplate(
      postRequest("/api/admin/email-templates/reset", {
        templateName: "password-reset",
      }),
    );

    const metadata = mocks.auditLogCreate.mock.calls.at(-1)?.[0].data.metadata;
    expect(metadata.deletedOverride.bodyText).toContain(
      "Reset Password=[REDACTED]",
    );
    expect(metadata.deletedOverride.bodyText).not.toContain("{{token}}");
    // Every other line is kept, so the archive is still worth having — the
    // caveat is one masked line, not a masked copy.
    expect(metadata.deletedOverride.bodyText).toContain(
      "You requested a password reset",
    );
    expect(metadata.deletedOverride.bodyText).toContain(
      "Your password will remain unchanged.",
    );
  });

  it("renders membership cancellation refund policy defaults through preview", async () => {
    const templatesResponse = await getEmailTemplates();
    const templatesBody = await templatesResponse.json();
    const confirmationTemplate = templatesBody.templates.find(
      (template: { key: string }) =>
        template.key === "membership-cancellation-confirmation",
    );
    const approvedTemplate = templatesBody.templates.find(
      (template: { key: string }) =>
        template.key === "membership-cancellation-approved",
    );

    expect(confirmationTemplate.defaultBody).toContain(
      "Paid subscriptions are non-refundable",
    );
    expect(confirmationTemplate.defaultBody).toContain(
      "unpaid or overdue subscription invoice will be cancelled",
    );
    expect(approvedTemplate.defaultBody).toContain(
      "Paid subscriptions will not be refunded",
    );
    expect(approvedTemplate.defaultBody).toContain(
      "invoice has been cancelled with a Xero credit note",
    );

    for (const templateName of [
      "membership-cancellation-confirmation",
      "membership-cancellation-approved",
    ] as const) {
      const definition = getEmailTemplateDefinition(templateName);
      expect(definition).toBeDefined();

      const response = await previewEmailTemplate(
        postRequest("/api/admin/email-templates/preview", {
          templateName,
          subject: definition!.defaultSubject,
          bodyText: definition!.defaultBody,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.html).toContain("Xero credit note");
      expect(body.html).toMatch(/Paid subscriptions (are|will)/);
    }
  });

  it("updates editable delivery policies and blocks locked system policies", async () => {
    const lockedResponse = await putDeliveryPolicy(
      request("/api/admin/notification-delivery-policies", {
        templateName: "admin-email-failure",
        mode: "disabled",
      }),
    );

    expect(lockedResponse.status).toBe(400);

    const response = await putDeliveryPolicy(
      request("/api/admin/notification-delivery-policies", {
        templateName: "admin-daily-digest",
        mode: "disabled",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.notificationDeliveryPolicyUpsert).toHaveBeenCalledWith({
      where: { templateName: "admin-daily-digest" },
      create: expect.objectContaining({
        templateName: "admin-daily-digest",
        mode: "DISABLED",
        updatedByMemberId: "admin-1",
      }),
      update: expect.objectContaining({
        mode: "DISABLED",
        updatedByMemberId: "admin-1",
      }),
    });
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("reports stale delivery policies without listing them as current policies", async () => {
    mocks.notificationDeliveryPolicyFindMany.mockResolvedValue([
      {
        templateName: "admin-daily-digest",
        mode: "DISABLED",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        templateName: "retired-admin-template",
        mode: "ALWAYS",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getDeliveryPolicies();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.policies.some(
        (policy: { templateName: string }) =>
          policy.templateName === "retired-admin-template",
      ),
    ).toBe(false);
    expect(
      body.policies.find(
        (policy: { templateName: string }) =>
          policy.templateName === "admin-daily-digest",
      ).mode,
    ).toBe("disabled");
    expect(body.stalePolicyCount).toBe(1);
    expect(body.stalePolicies).toEqual([
      expect.objectContaining({ templateName: "retired-admin-template" }),
    ]);
  });
});
