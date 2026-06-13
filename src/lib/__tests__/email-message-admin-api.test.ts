import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  emailTemplateOverrideFindUnique: vi.fn(),
  emailTemplateOverrideUpsert: vi.fn(),
  emailTemplateOverrideFindMany: vi.fn(),
  emailMessageSettingFindUnique: vi.fn(),
  emailMessageSettingUpsert: vi.fn(),
  notificationDeliveryPolicyFindUnique: vi.fn(),
  notificationDeliveryPolicyUpsert: vi.fn(),
  notificationDeliveryPolicyFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailTemplateOverride: {
      findUnique: mocks.emailTemplateOverrideFindUnique,
      upsert: mocks.emailTemplateOverrideUpsert,
      findMany: mocks.emailTemplateOverrideFindMany,
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
    },
  },
}));

import {
  GET as getEmailTemplates,
  PUT as putEmailTemplate,
} from "@/app/api/admin/email-templates/route";
import { POST as previewEmailTemplate } from "@/app/api/admin/email-templates/preview/route";
import { PUT as putEmailSettings } from "@/app/api/admin/email-settings/route";
import {
  GET as getDeliveryPolicies,
  PUT as putDeliveryPolicy,
} from "@/app/api/admin/notification-delivery-policies/route";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

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
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
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
  });

  it("blocks non-admin users", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });

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
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });

    const response = await putEmailSettings(
      request("/api/admin/email-settings", { doorCode: "2468" }),
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

  it("rejects override subjects containing the door code token", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "Door code {{doorCode}} - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid email template");
    expect(body.sensitiveSubjectTokens).toContain("doorCode");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("saves booking-confirmed overrides with the door code only in the body", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
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

  it("saves door code changes without audit logging the code value", async () => {
    mocks.emailMessageSettingFindUnique.mockResolvedValue({
      id: "default",
      doorCode: "1357",
      lodgeTravelNote: "Old directions",
    });

    const response = await putEmailSettings(
      request("/api/admin/email-settings", { doorCode: " 2468 " }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailMessageSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          doorCode: "2468",
        }),
        update: expect.objectContaining({
          doorCode: "2468",
        }),
      }),
    );

    const auditPayload = mocks.auditLogCreate.mock.calls.at(-1)?.[0];
    const serializedAuditPayload = JSON.stringify(auditPayload);
    expect(serializedAuditPayload).not.toContain("1357");
    expect(serializedAuditPayload).not.toContain("2468");
    expect(auditPayload.data.metadata).toEqual(
      expect.objectContaining({
        changedKeys: ["doorCode"],
        previousSettings: expect.objectContaining({ doorCode: "[set]" }),
        newSettings: expect.objectContaining({ doorCode: "[set]" }),
      }),
    );
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
