/**
 * The email templates route's read (`GET /api/admin/email-templates`): what
 * it answers a browser or an AI app connection (ALP-724, `INV-MCP-006`).
 * `?templateName=` answers that one template whole: every template's wording
 * at once is more than an AI app's answer can carry. The website reads the
 * list, which a connection gets without wording.
 */
import { NextResponse, type NextRequest } from "next/server";

import { emailTemplatesQuerySchema } from "@/lib/admin-support-api/messages";
import type { ConnectionShape } from "@/lib/connection-projection";
import {
  EMAIL_TEMPLATE_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE,
  type EmailTemplateAnswer,
  type EmailTemplateListAnswer,
} from "@/lib/connection-shapes/support-messages";
import { EMAIL_TEMPLATE_KEY_SET } from "@/lib/email-message-registry";

/** The template `?templateName=` names, or undefined for the list; a refusal for an unknown one. */
export function readTemplateQuery(
  request: NextRequest,
): { ok: true; templateName: string | undefined } | { ok: false; response: NextResponse } {
  const query = emailTemplatesQuerySchema.safeParse({
    templateName: request.nextUrl.searchParams.get("templateName") ?? undefined,
  });
  if (!query.success) {
    return { ok: false, response: NextResponse.json({ error: "Invalid query" }, { status: 400 }) };
  }
  const { templateName } = query.data;
  if (templateName !== undefined && !EMAIL_TEMPLATE_KEY_SET.has(templateName)) {
    return { ok: false, response: NextResponse.json({ error: "Unknown email template" }, { status: 404 }) };
  }
  return { ok: true, templateName };
}

/**
 * The list, or the one template `readTemplateQuery` named, each with the
 * connection shape the route answers it through (`connectionJson`).
 */
export function templatesAnswer(
  templateName: string | undefined,
  list: EmailTemplateListAnswer,
): { body: EmailTemplateListAnswer | { template: EmailTemplateAnswer }; shape: ConnectionShape } {
  if (templateName === undefined) return { body: list, shape: EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE };
  const template = list.templates.find((entry) => entry.key === templateName)!;
  return { body: { template }, shape: EMAIL_TEMPLATE_CONNECTION_SHAPE };
}
