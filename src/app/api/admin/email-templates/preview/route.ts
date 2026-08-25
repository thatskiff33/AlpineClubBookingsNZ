import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  EMAIL_TEMPLATE_KEY_SET,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  emailBodyHtmlToText,
  sanitiseEmailBodyHtml,
} from "@/lib/email-body-html";
import {
  renderEmailTemplatePreview,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import { bookingAddToCalendarHtmlRow } from "@/lib/calendar-links";
import { requireAdmin } from "@/lib/session-guards";

const previewSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().min(1).max(500),
    // Optional since fork #38: a rich preview sends bodyHtml instead.
    bodyText: z.string().trim().min(1).max(10000).optional(),
    // Fork #38: the rich-editor body. Sanitised before rendering, exactly as
    // a save would, so the admin sees what a member receives.
    bodyHtml: z.string().trim().max(20000).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.bodyText) || Boolean(value.bodyHtml),
    "A bodyText or bodyHtml is required",
  );

export async function POST(request: NextRequest) {
  // Preview renders a template with sample data and performs no mutation, so a
  // support:view admin may use it (issue #1940). Explicit view keeps it usable
  // for viewers even though the method is POST (which would infer edit).
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  // Fork #38: a rich body previews via its sanitised form and validates via
  // its derived text — the exact pipeline a save-then-send runs. An emptied
  // body (markup with no text) previews as NO rich body, mirroring the save
  // path's H1 rule.
  const sanitizedCandidate = parsed.data.bodyHtml
    ? sanitiseEmailBodyHtml(parsed.data.bodyHtml) || undefined
    : undefined;
  const sanitizedBodyHtml =
    sanitizedCandidate && emailBodyHtmlToText(sanitizedCandidate)
      ? sanitizedCandidate
      : undefined;
  const validation = validateEmailTemplateContent({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject,
    bodyText: sanitizedBodyHtml
      ? emailBodyHtmlToText(sanitizedBodyHtml)
      : (parsed.data.bodyText ?? ""),
  });
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "Invalid email template",
        issues: validation.issues,
        unknownTokens: validation.unknownTokens,
        disallowedTokens: validation.disallowedTokens,
        missingRequiredTokens: validation.missingRequiredTokens,
        signPrefixedTokens: validation.signPrefixedTokens,
        sensitiveSubjectTokens: validation.sensitiveSubjectTokens,
        unsafeLinks: validation.unsafeLinks,
        bracketAnnotations: validation.bracketAnnotations,
      },
      { status: 400 },
    );
  }

  const definition = getEmailTemplateDefinition(parsed.data.templateName);

  // Review finding 6: an EMPTIED rich body means "no override body", and a
  // SEND then renders the built-in default — so the preview must too, or the
  // admin who clears the box sees a blank email and concludes that is what
  // members get. The doc promise is "the exact email a member receives".
  const previewBodyText =
    parsed.data.bodyText ??
    (sanitizedBodyHtml ? "" : (definition?.defaultBody ?? ""));
  // Fork #43: preview {{ical}} as the ICON ROW the send renders, not the
  // flat sample text — the editor must tell the truth. The fixture URLs
  // mirror sampleValue("ical")'s documented sample set.
  const sampleData = definition?.sampleData?.ical
    ? {
        ...definition.sampleData,
        icalHtml: bookingAddToCalendarHtmlRow({
          icsUrl:
            "https://bookings.example.org/api/booking-calendar/bkg_example?token=sample&exp=1791244800",
          googleUrl:
            "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Example+Lodge+stay&dates=20260801/20260806",
          outlookUrl:
            "https://outlook.live.com/calendar/0/deeplink/compose?rru=addevent&allday=true&startdt=2026-08-01&enddt=2026-08-06",
        }),
      }
    : definition?.sampleData;
  const preview = await renderEmailTemplatePreview({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject,
    bodyText: previewBodyText,
    bodyHtml: sanitizedBodyHtml,
    templateData: sampleData,
  });

  return NextResponse.json(preview);
}
