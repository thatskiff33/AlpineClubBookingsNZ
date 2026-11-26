/**
 * ALP-724 (`INV-MCP-006`): the email template actions an officer's AI app
 * connection may run. The list carries no wording, since every template's
 * wording at once would not fit in an answer; `get_email_template` reads one
 * template whole through `?templateName=`, which the website does not use, so
 * its list answer is unchanged. Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * The registry is cut to one template so a fixture can carry a saved override
 * for every template the route lists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    emailTemplateOverride: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn(), findMany: vi.fn() },
  };
  return { prisma, requireAdmin: vi.fn(), renderPreview: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/email-message-registry", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/email-message-registry");
  const only = actual.EMAIL_TEMPLATE_DEFINITIONS.find((definition) => definition.key === "booking-confirmed")!;
  return { ...actual, EMAIL_TEMPLATE_DEFINITIONS: [only], EMAIL_TEMPLATE_KEY_SET: new Set([only.key]) };
});
vi.mock("@/lib/email-message-renderer", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-message-renderer")),
  renderEmailTemplatePreview: h.renderPreview,
}));

import { POST as previewTemplate } from "@/app/api/admin/email-templates/preview/route";
import { POST as resetTemplate } from "@/app/api/admin/email-templates/reset/route";
import { GET as getTemplates, PUT as putTemplate } from "@/app/api/admin/email-templates/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { EMAIL_TEMPLATE_DEFINITIONS } from "@/lib/email-message-registry";
import { findMcpAction } from "@/lib/mcp/catalogue";
import { EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-messages";

const STAMP = new Date("2026-06-30T00:00:00.000Z");
const TEMPLATE = EMAIL_TEMPLATE_DEFINITIONS[0]!;

const OVERRIDE = {
  templateName: TEMPLATE.key,
  subject: "Booked: {{bookingReference}}",
  bodyText: TEMPLATE.defaultBody,
  bodyHtml: null,
  updatedAt: STAMP,
  updatedByMemberId: "officer-9",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.prisma.emailTemplateOverride.findMany.mockResolvedValue([OVERRIDE]);
  h.prisma.auditLog.findMany.mockResolvedValue([]);
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("list_email_templates", () => {
  it("lists each template's subject and state without its wording, the browser's answer unchanged", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "list_email_templates",
      handler: getTemplates,
      // The stale-override lists are empty here: no saved change is stale.
      oneOfSeveralAnswers: true,
    });
    const [entry] = (connection as { templates: Array<Record<string, unknown>> }).templates;
    expect(Object.keys(entry!).sort()).toEqual(
      Object.keys(EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE.templates as object).sort(),
    );
    expect(entry).toMatchObject({
      key: TEMPLATE.key,
      override: { subject: OVERRIDE.subject, updatedAt: STAMP.toISOString() },
    });
    expect(JSON.stringify(connection)).not.toContain(TEMPLATE.defaultBody.slice(0, 40));
    // The website still reads every template whole.
    expect((browser as { templates: Array<{ defaultBody: string }> }).templates[0]!.defaultBody).toBe(
      TEMPLATE.defaultBody,
    );
  });
});

describe("get_email_template", () => {
  it("answers one template whole: its default, its tokens and the club's saved wording", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "get_email_template",
      handler: getTemplates,
      args: { templateName: TEMPLATE.key },
    });
    expect(connection).toMatchObject({
      template: {
        key: TEMPLATE.key,
        defaultBody: TEMPLATE.defaultBody,
        override: { subject: OVERRIDE.subject, bodyText: OVERRIDE.bodyText, bodyHtml: null },
      },
    });
    expect(JSON.stringify(connection)).not.toContain("officer-9");
    expect(JSON.stringify(browser)).toContain("officer-9");
  });

  it("answers 404 for a template the club does not have", async () => {
    const { request, context } = buildActionRequest(
      findMcpAction("get_email_template")!,
      { templateName: "no-such-template" },
      true,
    );
    const response = await getTemplates(request as never, context as never);
    expect(response.status).toBe(404);
  });
});

describe("preview_email_template", () => {
  it("renders the subject and body with sample data and saves nothing", async () => {
    h.renderPreview.mockResolvedValue({ subject: "Booked: BK-1", html: "<p>Booked</p>" });
    const { connection } = await expectActionContract({
      actionId: "preview_email_template",
      handler: previewTemplate,
      args: { templateName: TEMPLATE.key, subject: TEMPLATE.defaultSubject, bodyText: TEMPLATE.defaultBody },
    });
    expect(connection).toEqual({ subject: "Booked: BK-1", html: "<p>Booked</p>" });
    expect(h.prisma.emailTemplateOverride.upsert).not.toHaveBeenCalled();
  });
});

describe("update_email_template and reset_email_template", () => {
  it("saves the club's subject and body for the template", async () => {
    h.prisma.emailTemplateOverride.findUnique.mockResolvedValue(null);
    h.prisma.emailTemplateOverride.upsert.mockResolvedValue({ id: "override-1", ...OVERRIDE });
    const { connection } = await expectActionContract({
      actionId: "update_email_template",
      handler: putTemplate,
      args: { templateName: TEMPLATE.key, subject: TEMPLATE.defaultSubject, bodyText: TEMPLATE.defaultBody },
    });
    expect(connection).toEqual({
      override: {
        templateName: TEMPLATE.key,
        subject: OVERRIDE.subject,
        bodyText: OVERRIDE.bodyText,
        bodyHtml: null,
        updatedAt: STAMP.toISOString(),
      },
    });
    expect(h.prisma.emailTemplateOverride.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { templateName: TEMPLATE.key } }),
    );
  });

  it("resets the template to its default", async () => {
    h.prisma.emailTemplateOverride.findUnique.mockResolvedValue(OVERRIDE);
    h.prisma.emailTemplateOverride.deleteMany.mockResolvedValue({ count: 1 });
    const { connection } = await expectActionContract({
      actionId: "reset_email_template",
      handler: resetTemplate,
      args: { templateName: TEMPLATE.key },
    });
    expect(connection).toEqual({ reset: true });
  });
});
