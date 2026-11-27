/**
 * ALP-724 (`INV-MCP-006`): the email template actions an officer's AI app
 * connection may run. The list carries no wording, since every template's
 * wording at once would not fit in an answer; `get_email_template` reads one
 * template whole through `?templateName=`, which the website does not use, so
 * its list answer is unchanged. Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * The registry's list is cut to one template so a fixture can carry a saved
 * override for every template the route lists. The route still knows every
 * real template name, so a connection's change to a template that carries a
 * one-time sign-in link (`ACCESS_TEMPLATE`) or prints the club's bank-transfer
 * instructions can be seen refused.
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
  // Every real key stays known, so the refusals below reach every template they cover.
  return { ...actual, EMAIL_TEMPLATE_DEFINITIONS: [only] };
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
import { emailTemplateCarriesAccessToken } from "@/lib/email-template-access-token";
import {
  emailTemplateCarriesPaymentInstructions,
  PAYMENT_INSTRUCTION_EMAIL_TOKENS,
} from "@/lib/email-template-payment-instructions";
import {
  BOOKING_MESSAGE_DEFINITION_BY_KEY,
  EMAIL_TEMPLATE_PAYMENT_INSTRUCTIONS_WEBSITE_ONLY,
} from "@/lib/booking-message-definitions";
import { EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES } from "@/lib/credit-release-bank-transfer";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { NextRequest } from "next/server";
import { findMcpAction } from "@/lib/mcp/catalogue";
import { EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-messages";

const STAMP = new Date("2026-06-30T00:00:00.000Z");
const TEMPLATE = EMAIL_TEMPLATE_DEFINITIONS[0]!;
const ACCESS_TEMPLATE = "password-reset";

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
    const { request } = buildActionRequest(
      findMcpAction("get_email_template")!,
      { templateName: "no-such-template" },
      true,
    );
    const response = await getTemplates(request as never);
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

  it("refuses a connection changing a template that carries a one-time link, and saves nothing", async () => {
    expect(emailTemplateCarriesAccessToken(ACCESS_TEMPLATE)).toBe(true);
    expect(emailTemplateCarriesAccessToken(TEMPLATE.key)).toBe(false);
    // The catalogue's schema accepts it: the refusal is the route's.
    const { request } = buildActionRequest(
      findMcpAction("update_email_template")!,
      { templateName: ACCESS_TEMPLATE, bodyText: "Reset here: https://attacker.example/reset?token={{token}}" },
      true,
    );
    const response = await putTemplate(request as never);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/club website/);
    expect(h.prisma.emailTemplateOverride.upsert).not.toHaveBeenCalled();
  });

  it("still lets the website reach that template's save", async () => {
    // Past the connection refusal, the route's own content rules apply.
    const request = new NextRequest(new URL("/api/admin/email-templates", "https://club.example.test"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateName: ACCESS_TEMPLATE, subject: "Reset your password" }),
    });
    const response = await putTemplate(request as never);
    expect(response.status).not.toBe(403);
    expect(request.headers.has(MCP_PRINCIPAL_HEADER)).toBe(false);
  });
});

describe("emailTemplateCarriesAccessToken", () => {
  it("covers every template that may use a one-time {{token}} link, from the required-token table", async () => {
    const actual = (await vi.importActual("@/lib/email-message-registry")) as typeof import("@/lib/email-message-registry");
    const usesToken = actual.EMAIL_TEMPLATE_DEFINITIONS.filter((definition) =>
      definition.allowedTokens.includes("token"),
    ).map((definition) => definition.key);
    expect(usesToken.length).toBeGreaterThan(0);
    expect(usesToken.filter((key) => !emailTemplateCarriesAccessToken(key))).toEqual([]);
  });
});

/** The real registry, past this file's mock: what a census must cover. */
async function realTemplateDefinitions() {
  const actual = (await vi.importActual("@/lib/email-message-registry")) as typeof import("@/lib/email-message-registry");
  return actual.EMAIL_TEMPLATE_DEFINITIONS;
}

describe("templates printing the club's bank-transfer instructions (ALP-724)", () => {
  const PAYMENT_TEMPLATE = "credit-released-payment-request";

  it("derives the tokens from the booking messages' own flag: {{bankTransferNote}} renders a flagged message", () => {
    expect(EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES.bankTransferNote).toBe("paymentRequest.bankTransfer.instructions");
    expect(
      BOOKING_MESSAGE_DEFINITION_BY_KEY.get("paymentRequest.bankTransfer.instructions")?.carriesPaymentInstructions,
    ).toBe(true);
    expect([...PAYMENT_INSTRUCTION_EMAIL_TOKENS]).toEqual(["bankTransferNote"]);
    expect(emailTemplateCarriesPaymentInstructions(PAYMENT_TEMPLATE)).toBe(true);
    expect(emailTemplateCarriesPaymentInstructions(TEMPLATE.key)).toBe(false);
  });

  it("refuses, through the dispatch path, a connection changing every template that allows such a token", async () => {
    // Computed from the declaration and the flags, independently of the helper the route calls.
    const flaggedTokens = Object.entries(EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES)
      .filter(([, messageKey]) => BOOKING_MESSAGE_DEFINITION_BY_KEY.get(messageKey)?.carriesPaymentInstructions)
      .map(([token]) => token);
    const covered = (await realTemplateDefinitions())
      .filter((definition) => definition.allowedTokens.some((token) => flaggedTokens.includes(token)))
      .map((definition) => definition.key);
    expect(covered).toContain(PAYMENT_TEMPLATE);
    for (const templateName of covered) {
      // The lane's probe: the token dropped and a fixed account written in its place.
      const { request } = buildActionRequest(
        findMcpAction("update_email_template")!,
        { templateName, bodyText: "Hi {{firstName}}, pay into 12-3456-7890123-00 today." },
        true,
      );
      const response = await putTemplate(request as never);
      expect(response.status, templateName).toBe(403);
      expect(await response.json(), templateName).toEqual({ error: EMAIL_TEMPLATE_PAYMENT_INSTRUCTIONS_WEBSITE_ONLY });
    }
    expect(h.prisma.emailTemplateOverride.upsert).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("still lets a connection reset such a template to its default", async () => {
    h.prisma.emailTemplateOverride.findUnique.mockResolvedValue({ ...OVERRIDE, templateName: PAYMENT_TEMPLATE });
    h.prisma.emailTemplateOverride.deleteMany.mockResolvedValue({ count: 1 });
    const { request } = buildActionRequest(findMcpAction("reset_email_template")!, { templateName: PAYMENT_TEMPLATE }, true);
    const response = await resetTemplate(request as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true });
  });

  it("still lets the website reach that template's save", async () => {
    const request = new NextRequest(new URL("/api/admin/email-templates", "https://club.example.test"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateName: PAYMENT_TEMPLATE, subject: "Payment needed" }),
    });
    const response = await putTemplate(request as never);
    expect(response.status).not.toBe(403);
  });

  it("finds every lib module that renders a booking message, so a new email token built from one is declared", () => {
    // A module reading or rendering booking-message wording outside the booking-message modules
    // could put it into an email token. Each such token must sit in
    // EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES, or the refusal above cannot see it.
    const libRoot = join(process.cwd(), "src/lib");
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__") walk(path);
        } else if (/\.tsx?$/.test(name) && /\b(renderBookingMessageTemplate|loadPublicBookingMessages)\(/.test(readFileSync(path, "utf8"))) {
          readers.push(relative(libRoot, path));
        }
      }
    };
    walk(libRoot);
    expect(readers.sort()).toEqual([
      "booking-message-definitions.ts",
      "booking-message-settings.ts",
      // Declares `bankTransferNote` in EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES.
      "credit-release-bank-transfer.ts",
    ]);
  });
});
