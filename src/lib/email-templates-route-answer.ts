/**
 * The email templates route's read (`GET /api/admin/email-templates`), as it
 * answers a browser or an AI app connection (ALP-724, `INV-MCP-006`).
 * `?templateName=` answers that one template whole: every template's wording
 * at once is more than an AI app's answer can carry. The website reads the
 * list, which a connection gets without wording.
 */
import { NextResponse, type NextRequest } from "next/server";

import { emailTemplatesQuerySchema } from "@/lib/admin-support-api/messages";
import {
  EMAIL_TEMPLATE_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE,
  type EmailTemplateAnswer,
  type EmailTemplateListAnswer,
} from "@/lib/connection-shapes/support-messages";
import { EMAIL_TEMPLATE_KEY_SET } from "@/lib/email-message-registry";
import { connectionJson } from "@/lib/mcp-connection-request";

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

/** The list, or the one template `readTemplateQuery` named, each through its connection shape. */
export function answerTemplates(request: NextRequest, templateName: string | undefined, list: EmailTemplateListAnswer) {
  if (templateName === undefined) {
    return connectionJson(request, list, EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE);
  }
  const template: EmailTemplateAnswer = list.templates.find((entry) => entry.key === templateName)!;
  return connectionJson(request, { template }, EMAIL_TEMPLATE_CONNECTION_SHAPE);
}
