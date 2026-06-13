import { plainTextEmailTemplate } from "@/lib/email-templates";
import {
  applyEmailMessageSettingsToHtml,
  applyEmailMessageSettingsToSubject,
  buildEmailTemplateGlobalData,
  loadEmailMessageSettings,
  type EmailMessageSettings,
} from "@/lib/email-message-settings";
import {
  APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
  SENSITIVE_EMAIL_SUBJECT_TOKEN_SET,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";

export type EmailTemplateValue = string | number | boolean | null | undefined;
export type EmailTemplateData = Record<string, EmailTemplateValue>;

export interface EmailTemplateOverrideRecord {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
}

export interface PreparedEmailMessage {
  subject: string;
  html: string;
  settings: EmailMessageSettings;
  overrideApplied: boolean;
}

export interface EmailTemplateValidationIssue {
  code:
    | "unknown_template"
    | "unknown_token"
    | "disallowed_token"
    | "missing_required_token"
    | "sensitive_subject_token"
    | "subject_line_break"
    | "raw_html"
    | "unsafe_link";
  field?: "subject" | "bodyText";
  message: string;
  tokens?: string[];
  links?: string[];
}

export interface EmailTemplateValidationResult {
  valid: boolean;
  issues: EmailTemplateValidationIssue[];
  unknownTokens: string[];
  disallowedTokens: string[];
  missingRequiredTokens: string[];
  sensitiveSubjectTokens: string[];
  unsafeLinks: string[];
}

export function extractTemplateTokens(value: string): string[] {
  return Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

export function validateApprovedTemplateTokens(values: string[]): string[] {
  return Array.from(
    new Set(
      values.flatMap(extractTemplateTokens).filter(
        (token) => !APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token),
      ),
    ),
  );
}

function findRawHtmlFields({
  subject,
  bodyText,
}: {
  subject: string;
  bodyText: string;
}): Array<"subject" | "bodyText"> {
  const rawHtmlPattern = /<\/?[a-z][^>]*>/i;
  return [
    rawHtmlPattern.test(subject) ? "subject" : null,
    rawHtmlPattern.test(bodyText) ? "bodyText" : null,
  ].filter((field): field is "subject" | "bodyText" => field !== null);
}

function normalizeLinkCandidate(value: string): string {
  return value.replace(/[.;]+$/g, "");
}

export function findUnsafeTemplateLinks(values: string[]): string[] {
  const unsafe = new Set<string>();
  const linkPattern =
    /(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|mailto:[^\s<>"']+|javascript:[^\s<>"']+|data:[^\s<>"']+|vbscript:[^\s<>"']+|www\.[^\s<>"']+)/gi;

  for (const value of values) {
    const sampleRendered = value.replace(/\{\{[^{}]+\}\}/g, "sample");
    for (const match of sampleRendered.matchAll(linkPattern)) {
      const link = normalizeLinkCandidate(match[0]);
      const lower = link.toLowerCase();
      if (lower.startsWith("http://") || lower.startsWith("https://")) {
        try {
          new URL(link);
          continue;
        } catch {
          unsafe.add(link);
          continue;
        }
      }
      if (lower.startsWith("mailto:")) {
        if (!/[\r\n]/.test(link)) continue;
      }
      unsafe.add(link);
    }
  }

  return Array.from(unsafe);
}

export function validateEmailTemplateContent({
  templateName,
  subject,
  bodyText,
}: {
  templateName: string;
  subject: string;
  bodyText: string;
}): EmailTemplateValidationResult {
  const definition = getEmailTemplateDefinition(templateName);
  const issues: EmailTemplateValidationIssue[] = [];
  const values = [subject, bodyText];
  const subjectTokens = Array.from(new Set(extractTemplateTokens(subject)));
  const bodyTokens = Array.from(new Set(extractTemplateTokens(bodyText)));
  const tokens = Array.from(new Set([...subjectTokens, ...bodyTokens]));
  const unknownTokens = tokens.filter(
    (token) => !APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token),
  );

  if (!definition) {
    issues.push({
      code: "unknown_template",
      message: "Unknown email template",
    });
  }

  if (unknownTokens.length > 0) {
    issues.push({
      code: "unknown_token",
      message: "Unknown template tokens",
      tokens: unknownTokens,
    });
  }

  const allowedTokenSet = new Set(definition?.allowedTokens ?? []);
  const disallowedTokens = definition
    ? tokens.filter((token) => !allowedTokenSet.has(token))
    : [];
  if (disallowedTokens.length > 0) {
    issues.push({
      code: "disallowed_token",
      message: "Template tokens are not allowed for this message",
      tokens: disallowedTokens,
    });
  }

  // Required tokens are body content (door codes, credential links), so they
  // must be present in the body itself — a token in the subject does not
  // satisfy the requirement. An empty body override falls back to the default
  // body, which already carries the required tokens, so it is not checked.
  const requiredTokenSet = new Set(definition?.requiredTokens ?? []);
  const bodyTokenSet = new Set(bodyTokens);
  const missingRequiredTokens =
    bodyText.trim().length > 0
      ? Array.from(requiredTokenSet).filter((token) => !bodyTokenSet.has(token))
      : [];
  if (missingRequiredTokens.length > 0) {
    issues.push({
      code: "missing_required_token",
      message: "Required template tokens are missing from the body",
      tokens: missingRequiredTokens,
    });
  }

  // Subjects are persisted in EmailLog and travel in clear mail headers, so
  // secret-bearing tokens are never allowed in a subject line.
  const sensitiveSubjectTokens = subjectTokens.filter((token) =>
    SENSITIVE_EMAIL_SUBJECT_TOKEN_SET.has(token),
  );
  if (sensitiveSubjectTokens.length > 0) {
    issues.push({
      code: "sensitive_subject_token",
      field: "subject",
      message:
        "Sensitive tokens such as door codes and credential links cannot be used in email subjects",
      tokens: sensitiveSubjectTokens,
    });
  }

  if (/[\r\n]/.test(subject)) {
    issues.push({
      code: "subject_line_break",
      field: "subject",
      message: "Email subjects cannot contain line breaks",
    });
  }

  for (const field of findRawHtmlFields({ subject, bodyText })) {
    issues.push({
      code: "raw_html",
      field,
      message: "Email templates must be plain text, not raw HTML",
    });
  }

  const unsafeLinks = findUnsafeTemplateLinks(values);
  if (unsafeLinks.length > 0) {
    issues.push({
      code: "unsafe_link",
      message: "Email template links must use http, https, or mailto",
      links: unsafeLinks,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    unknownTokens,
    disallowedTokens,
    missingRequiredTokens,
    sensitiveSubjectTokens,
    unsafeLinks,
  };
}

export function renderTemplateString(
  template: string,
  data: EmailTemplateData,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
    const key = tokenName.trim();
    const value = data[key];
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

// Defence in depth for subject rendering: even if a stored override slips a
// sensitive token into a subject (for example a row saved before save-time
// validation existed), the live value must never reach the subject, because
// EmailLog persists subjects for every template and mail headers travel in
// the clear.
function buildSubjectSafeTemplateData(data: EmailTemplateData): EmailTemplateData {
  const safe: EmailTemplateData = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SENSITIVE_EMAIL_SUBJECT_TOKEN_SET.has(key)) safe[key] = value;
  }
  return safe;
}

const SENSITIVE_SUBJECT_TOKEN_PATTERN = new RegExp(
  `\\{\\{\\s*(?:${Array.from(SENSITIVE_EMAIL_SUBJECT_TOKEN_SET).join("|")})\\s*\\}\\}`,
  "g",
);

// Minimum length for the literal-value scrub below; shorter strings are too
// likely to collide with legitimate subject text, and they can never be
// template-substituted into a subject because of buildSubjectSafeTemplateData.
const SENSITIVE_SUBJECT_VALUE_MIN_LENGTH = 3;

export function neutraliseSensitiveSubjectContent(
  subject: string,
  data: EmailTemplateData,
): string {
  let result = subject.replace(SENSITIVE_SUBJECT_TOKEN_PATTERN, "");
  // Last-resort scrub: drop any live sensitive value that somehow reached the
  // subject string through a non-template path.
  for (const token of SENSITIVE_EMAIL_SUBJECT_TOKEN_SET) {
    const value = data[token];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < SENSITIVE_SUBJECT_VALUE_MIN_LENGTH) continue;
    result = result.split(trimmed).join("");
  }
  if (result === subject) return subject;
  return result.replace(/\s{2,}/g, " ").trim();
}

async function loadTemplateOverride(
  templateName: string,
): Promise<EmailTemplateOverrideRecord | null> {
  const delegate = (prisma as unknown as {
    emailTemplateOverride?: {
      findUnique: (args: unknown) => Promise<EmailTemplateOverrideRecord | null>;
    };
  }).emailTemplateOverride;

  if (!delegate) return null;

  try {
    return await delegate.findUnique({ where: { templateName } });
  } catch {
    return null;
  }
}

export function buildEmailTemplateData(
  settings: EmailMessageSettings,
  templateData?: EmailTemplateData,
): EmailTemplateData {
  return {
    ...buildEmailTemplateGlobalData(settings),
    ...(templateData ?? {}),
  };
}

export async function prepareEmailMessage({
  templateName,
  subject,
  html,
  templateData,
}: {
  templateName: string;
  subject: string;
  html: string;
  templateData?: EmailTemplateData;
}): Promise<PreparedEmailMessage> {
  const settings = await loadEmailMessageSettings();
  const override = getEmailTemplateDefinition(templateName)
    ? await loadTemplateOverride(templateName)
    : null;
  const data = buildEmailTemplateData(settings, templateData);

  let nextSubject = subject;
  let nextHtml = html;
  let overrideApplied = false;

  if (override?.subject?.trim()) {
    // Subjects render without sensitive values so a stored override can never
    // substitute a door code or credential link into the subject line.
    nextSubject = renderTemplateString(
      override.subject.trim(),
      buildSubjectSafeTemplateData(data),
    );
    overrideApplied = true;
  }

  if (override?.bodyText?.trim()) {
    nextHtml = plainTextEmailTemplate(
      renderTemplateString(override.bodyText.trim(), data),
    );
    overrideApplied = true;
  }

  return {
    subject: applyEmailMessageSettingsToSubject(
      neutraliseSensitiveSubjectContent(nextSubject, data),
      settings,
    ),
    html: applyEmailMessageSettingsToHtml(nextHtml, settings),
    settings,
    overrideApplied,
  };
}

export async function renderEmailTemplatePreview({
  subject,
  bodyText,
  templateData,
}: {
  subject: string;
  bodyText: string;
  templateData?: EmailTemplateData;
}) {
  const settings = await loadEmailMessageSettings();
  const data = buildEmailTemplateData(settings, templateData);
  // Preview subjects render with the same sensitive-token stripping as real
  // sends so the admin preview matches delivered mail.
  const renderedSubject = applyEmailMessageSettingsToSubject(
    neutraliseSensitiveSubjectContent(
      renderTemplateString(subject, buildSubjectSafeTemplateData(data)),
      data,
    ),
    settings,
  );
  const html = applyEmailMessageSettingsToHtml(
    plainTextEmailTemplate(renderTemplateString(bodyText, data)),
    settings,
  );

  return {
    subject: renderedSubject,
    html,
  };
}
