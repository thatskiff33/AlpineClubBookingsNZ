import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_KEY_SET,
} from "@/lib/email-message-registry";
import {
  EMPTYABLE_OVERRIDE_TOKENS,
  OPTIONAL_TEMPLATE_TOKENS,
  findBracketAnnotations,
  findDanglingDefaultLines,
  findUnconditionalLines,
} from "@/lib/email-message-token-contract";
import { validateEmailTemplateContent } from "@/lib/email-message-renderer";
import { prisma } from "@/lib/prisma";
import { isSameText } from "@/lib/text-diff";
import { requireAdmin } from "@/lib/session-guards";

interface EmailTemplateOverrideRecord {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  updatedAt: Date;
  updatedByMemberId: string | null;
}

const templateUpdateSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().max(500).nullable().optional(),
    bodyText: z.string().trim().max(10000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.subject !== undefined || value.bodyText !== undefined,
    "A subject or bodyText update is required",
  );

async function loadOverrides() {
  const delegate = (prisma as unknown as {
    emailTemplateOverride?: {
      findMany: () => Promise<EmailTemplateOverrideRecord[]>;
    };
  }).emailTemplateOverride;

  if (!delegate) return [];
  return delegate.findMany();
}

// #2269 (second review): the migration that stripped the authoring notes this
// project shipped out of every saved override. Its audit rows are the ONLY
// surviving record of which lines used to be conditional, because the bracket
// WAS the marker and the migration is what removed it.
const ANNOTATION_STRIP_MIGRATION_SOURCE =
  "migration:20260801150000_strip_email_override_bracket_annotations";

// One row per template at most (the migration runs once and is idempotent), so
// this is a small, bounded read; the cap is belt-and-braces against a hand-made
// row, not an expected case.
const ANNOTATION_STRIP_AUDIT_LIMIT = 200;

interface AnnotationStripRecord {
  createdAt: Date;
  removedAnnotations: string[];
  previousSubject: string | null;
  previousBody: string | null;
  newSubject: string | null;
  newBody: string | null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Read the migration's own audit rows and index them by template.
 *
 * Written defensively at every step. The metadata is JSON written by SQL rather
 * than by the app's builder, an operator can hand-write an AuditLog row, and
 * this runs on a read path an admin needs to work: anything that does not match
 * the shape the migration writes is skipped rather than trusted.
 */
async function loadAnnotationStripAudit(): Promise<
  Map<string, AnnotationStripRecord>
> {
  const delegate = (prisma as unknown as {
    auditLog?: {
      findMany?: (args: unknown) => Promise<
        Array<{ entityId: string | null; createdAt: Date; metadata: unknown }>
      >;
    };
  }).auditLog;
  if (!delegate?.findMany) return new Map();

  const rows = await delegate.findMany({
    where: {
      action: "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
      entityType: "EmailTemplateOverride",
      metadata: { path: ["source"], equals: ANNOTATION_STRIP_MIGRATION_SOURCE },
    },
    select: { entityId: true, createdAt: true, metadata: true },
    orderBy: { createdAt: "desc" },
    take: ANNOTATION_STRIP_AUDIT_LIMIT,
  });

  const byTemplate = new Map<string, AnnotationStripRecord>();
  for (const row of rows) {
    if (!row.entityId || byTemplate.has(row.entityId)) continue;
    const metadata = row.metadata as
      | {
          removedAnnotations?: unknown;
          previousOverride?: { subject?: unknown; bodyText?: unknown };
          newOverride?: { subject?: unknown; bodyText?: unknown };
        }
      | null
      | undefined;
    if (!metadata || typeof metadata !== "object") continue;
    const removedAnnotations = Array.isArray(metadata.removedAnnotations)
      ? metadata.removedAnnotations.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    if (removedAnnotations.length === 0) continue;
    byTemplate.set(row.entityId, {
      createdAt: row.createdAt,
      removedAnnotations,
      previousSubject: nullableString(metadata.previousOverride?.subject),
      previousBody: nullableString(metadata.previousOverride?.bodyText),
      newSubject: nullableString(metadata.newOverride?.subject),
      newBody: nullableString(metadata.newOverride?.bodyText),
    });
  }
  return byTemplate;
}

function serializeOverride(override: EmailTemplateOverrideRecord) {
  return {
    subject: override.subject,
    bodyText: override.bodyText,
    updatedAt: override.updatedAt.toISOString(),
    updatedByMemberId: override.updatedByMemberId,
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const overrides = await loadOverrides();
  const staleOverrides = overrides
    .filter((override) => !EMAIL_TEMPLATE_KEY_SET.has(override.templateName))
    .map((override) => ({
      templateName: override.templateName,
      ...serializeOverride(override),
    }));
  const overrideByTemplate = new Map(
    overrides
      .filter((override) => EMAIL_TEMPLATE_KEY_SET.has(override.templateName))
      .map((override) => [override.templateName, override]),
  );

  // #2268 review (MED-1): overrides saved from the pre-sweep editor text still
  // carry the "[only when …]" authoring notes as literal member-facing content.
  // Save-time validation now refuses them, but a row that is never re-saved
  // would keep sending the junk forever and nothing would say so. Run guard 1's
  // detector over every stored override (registered AND stale — a stale row can
  // still matter to an operator deciding what to re-author) so the panel can
  // name exactly which templates still carry the junk without an admin opening
  // each one.
  const bracketAnnotationOverrides = overrides
    .map((override) => {
      const findings = findBracketAnnotations({
        [override.templateName]: {
          defaultSubject: override.subject ?? "",
          defaultBody: override.bodyText ?? "",
        },
      });
      if (findings.length === 0) return null;
      return {
        templateName: override.templateName,
        annotations: findings.flatMap((finding) => finding.detail.split(" | ")),
      };
    })
    .filter(
      (entry): entry is { templateName: string; annotations: string[] } =>
        entry !== null,
    );

  // #2269 (F3): the advisory half. Everything above answers "is this override
  // still VALID?"; this answers the question an admin actually asks — "my saved
  // copy is not the built-in wording any more; does that matter?"
  //
  // WHY THIS IS NOT A HASH COMPARISON. The tempting design is to stamp each
  // override with a hash of the default it was authored against and flag any
  // row whose stamp no longer matches. It was rejected twice over. First, a
  // stamp can only describe saves made AFTER it ships: every row that exists
  // today — the entire population this issue exists for — would carry no stamp
  // and the feature would be dark on exactly the clubs it is for, and there is
  // no honest way to backfill it because nobody knows which historical default
  // a given club copied. Second, and worse, it fires on every release that
  // touches a default at all, including a comma in a paragraph the club deleted
  // years ago; its only remedy is Restore Default, which destroys the
  // customisation. That is precisely the false "you have drifted" noise #2269
  // says not to produce.
  //
  // So the WARNING is reserved for things that are objectively wrong with the
  // saved copy, each one already defined by a rule the save path enforces, and
  // the plain fact "your copy differs from the built-in wording" is reported
  // WITHOUT alarm alongside a diff, because differing is what an override is
  // FOR. The reasons are:
  //
  //   missing_required_token — the registry says this email must show the
  //     member something (the promo explanation, the way into the lodge) and
  //     the saved body no longer does. Honours requiredTokenAlternatives
  //     (#2267), so a club that writes its own "Door code: {{doorCode}}" line
  //     instead of {{doorCodeNote}} is NOT nagged. This is the drift #2267
  //     created and nothing surfaced: such a row cannot even be re-saved today.
  //   retired_token / bracket_annotation — the two #2320 already banners. They
  //     are repeated per template so the editor can show one consolidated
  //     indicator on the template you have open, instead of making you read a
  //     list of names at the top of the page and match them up yourself.
  //   dangling_line — a line of the saved copy renders as a bare label when a
  //     token the sender can legitimately supply EMPTY comes back empty. This
  //     is the reason #2269's own migration made urgent: the shipped defaults
  //     padded "[only when discountCents > 0]" onto
  //     "Discount ({{promoCode}}): -{{discount}}", and once the migration
  //     removes the bracket the line still goes out as "Discount (): -" on an
  //     ordinary booking and "Discount (PEAK): -" on a promo that RAISED the
  //     price — a member charged MORE shown a "Discount" line, which is the
  //     #2267 incident word for word. This is objectively wrong output, not a
  //     matter of taste, so it belongs in `reasons` without breaching the rule
  //     that we never nag an admin about wording they chose.
  //   stripped_annotation — this row is one the #2269 migration rewrote, and it
  //     has not been saved since. It is NOT derived by re-detecting a marker —
  //     the marker is what the migration deleted — but from the migration's own
  //     audit row, which records the previous wording verbatim. It exists
  //     because `dangling_line` above can only see a line with a TOKEN in it: a
  //     conditional line of pure prose ("Payment has been processed
  //     successfully. [only when the booking is already paid]") is structurally
  //     invisible to guard 4, and before the migration the bracket itself was
  //     the signal. Without this, stripping that line's annotation would take a
  //     row from "bracket_annotation, with a banner" to nothing at all, and a
  //     member who still owes $240 would read that their payment succeeded.
  //   invalid_content — the catch-all. `reasons` above names five of the
  //     validator's eleven issue codes (stripped_annotation and dangling_line are
  //     this change's own, not the validator's); a row that trips one of the
  //     other six (a sensitive token in a subject is the reachable one, and
  //     #2774's missing_required_subject_token and forbidden_subject_phrase
  //     joined it) cannot be re-saved and would otherwise be told nothing at all.
  // Only a SAVED override can have been rewritten by the migration, so a club
  // that has never customised a message pays nothing for this.
  const strippedAnnotationsByTemplate =
    overrideByTemplate.size > 0
      ? await loadAnnotationStripAudit()
      : new Map<string, AnnotationStripRecord>();
  const staleContentByTemplate = new Map<
    string,
    {
      differsFromDefault: boolean;
      subjectDiffersFromDefault: boolean;
      bodyDiffersFromDefault: boolean;
      reasons: string[];
      missingRequiredTokens: string[];
      retiredTokens: string[];
      bracketAnnotations: string[];
      danglingLines: string[];
      strippedAnnotations: string[];
      unconditionalLines: string[];
    }
  >();
  for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
    const override = overrideByTemplate.get(definition.key);
    if (!override) continue;

    const validation = validateEmailTemplateContent({
      templateName: definition.key,
      subject: override.subject ?? "",
      bodyText: override.bodyText ?? "",
    });
    const retiredTokens = Array.from(
      new Set(
        validation.issues
          .filter(
            (issue) =>
              issue.code === "disallowed_token" || issue.code === "unknown_token",
          )
          .flatMap((issue) => issue.tokens ?? []),
      ),
    );
    // A null field means "fall back to the built-in wording", which is not a
    // difference — only a stored value that is not the default is. A BLANK
    // value means the same thing to the renderer and is treated the same way
    // here (#2269 review): the save route stores `subject || null` so the app
    // never creates one, but a row that predates that, or one written by hand,
    // would otherwise be reported as "your saved copy differs" with the whole
    // default diffed as removed — false drift over a row that renders exactly
    // the built-in wording.
    // isSameText, not ===, so a saved copy that differs only in line-ending
    // style (a browser/textarea round trip can introduce CRLF) is not reported
    // as a difference an admin should look at.
    const storedSubject = override.subject?.trim() ? override.subject : null;
    const storedBody = override.bodyText?.trim() ? override.bodyText : null;
    const subjectDiffersFromDefault =
      storedSubject !== null &&
      !isSameText(storedSubject, definition.defaultSubject);
    const bodyDiffersFromDefault =
      storedBody !== null && !isSameText(storedBody, definition.defaultBody);
    // Guard 4, run over the SAVED OVERRIDE rather than over a shipped default:
    // render every token the sender can supply empty as empty and see which
    // lines come out as a bare label. Both declaration tables are used —
    // OPTIONAL_TEMPLATE_TOKENS for the pre-composed blocks still in the default
    // body, EMPTYABLE_OVERRIDE_TOKENS for the legacy per-piece tokens only an
    // override can still be using. Anything not declared renders with its
    // preview sample, so a token that is always supplied cannot produce noise.
    const emptyableTokens = [
      ...(OPTIONAL_TEMPLATE_TOKENS[definition.key] ?? []),
      ...(EMPTYABLE_OVERRIDE_TOKENS[definition.key] ?? []),
    ];
    const danglingLines = findDanglingDefaultLines(
      {
        // A null field means "use the built-in wording", which this club did
        // not author and cannot be warned about — the defaults have their own
        // build-time guard-4 run.
        [definition.key]: {
          defaultSubject: override.subject ?? "",
          defaultBody: override.bodyText ?? "",
        },
      },
      { [definition.key]: emptyableTokens },
      (token) => definition.sampleData[token] ?? token,
    ).flatMap((finding) =>
      // Guard 4 reports its lines JSON-quoted and pipe-joined. Read them back
      // as JSON string literals rather than splitting on the pipe, because a
      // template line may legitimately contain " | ".
      Array.from(
        finding.detail.matchAll(/"(?:[^"\\]|\\.)*"/g),
        (match) => JSON.parse(match[0]) as string,
      ),
    );

    // What the #2269 migration took OUT of this row, if it took anything and
    // nobody has saved over it since.
    //
    // "Since" is tested two ways because either one alone has a hole. The
    // content check ("is this still exactly what the migration wrote?") cannot
    // see an admin who opened the template, read it, and pressed Save without
    // changing a character — a deliberate acknowledgement that should clear the
    // notice. The timestamp check catches that, but compares a Prisma
    // `@updatedAt` written from the APP's clock against a `createdAt` written
    // by the DATABASE's, so it is only reliable at the scale of a real edit
    // (minutes and hours after the upgrade), not microseconds. Requiring BOTH
    // to say "untouched" means either signal is enough to clear the notice,
    // which is the safe direction: the failure mode is telling an admin
    // something they have already dealt with, never staying silent.
    const stripped = strippedAnnotationsByTemplate.get(definition.key);
    const untouchedSinceStrip =
      stripped !== undefined &&
      (override.subject ?? null) === stripped.newSubject &&
      (override.bodyText ?? null) === stripped.newBody &&
      override.updatedAt.getTime() <= stripped.createdAt.getTime();
    const strippedAnnotations =
      untouchedSinceStrip && stripped ? stripped.removedAnnotations : [];
    // The lines those notes were marking, read off the previous wording. A note
    // that had a whole line to itself is not reported: the strip took the line
    // with it, so nothing new is being sent.
    const unconditionalLines =
      untouchedSinceStrip && stripped
        ? Array.from(
            new Set([
              ...findUnconditionalLines(stripped.previousSubject ?? ""),
              ...findUnconditionalLines(stripped.previousBody ?? ""),
            ]),
          )
        : [];

    const reasons = [
      validation.missingRequiredTokens.length > 0
        ? "missing_required_token"
        : null,
      retiredTokens.length > 0 ? "retired_token" : null,
      validation.bracketAnnotations.length > 0 ? "bracket_annotation" : null,
      danglingLines.length > 0 ? "dangling_line" : null,
      strippedAnnotations.length > 0 ? "stripped_annotation" : null,
      // The catch-all, last: a save this club can no longer make and no other
      // reason explains. Only raised when nothing above already covers it, so
      // the editor never says the same thing twice.
      !validation.valid &&
      validation.missingRequiredTokens.length === 0 &&
      retiredTokens.length === 0 &&
      validation.bracketAnnotations.length === 0
        ? "invalid_content"
        : null,
    ].filter((reason): reason is string => reason !== null);

    staleContentByTemplate.set(definition.key, {
      differsFromDefault: subjectDiffersFromDefault || bodyDiffersFromDefault,
      subjectDiffersFromDefault,
      bodyDiffersFromDefault,
      reasons,
      missingRequiredTokens: validation.missingRequiredTokens,
      retiredTokens,
      bracketAnnotations: validation.bracketAnnotations,
      danglingLines,
      strippedAnnotations,
      unconditionalLines,
    });
  }

  // The one reason with no banner of its own yet. Deliberately NOT a fourth
  // banner repeating what the two above already say — an admin who is told the
  // same thing three times stops reading all three.
  const missingRequiredTokenOverrides = [...staleContentByTemplate.entries()]
    .filter(([, staleContent]) => staleContent.missingRequiredTokens.length > 0)
    .map(([templateName, staleContent]) => ({
      templateName,
      tokens: staleContent.missingRequiredTokens,
    }));

  // #2307 review (M2): the same failure one level up. A token a template no
  // longer supplies renders as NOTHING — there is no conditional syntax and no
  // error — so an override written against an older default keeps sending, with
  // a hole in it, until somebody happens to re-save. The check-in reminder is
  // the live example: `{{guestFirstName}}`/`{{guestLastName}}` gave way to a
  // one-guest-per-line `{{guestName}}`, and a club holding the old pair would
  // have emailed a reminder listing NOBODY. (The sender keeps supplying the old
  // pair so those overrides still render correctly; this is how the admin
  // learns to move off them.) Reuses the SAVE-TIME validator rather than a
  // second rule, so "your save was refused for this" and "your saved override
  // has this" can never disagree.
  //
  // #2269 reads the SAME computation off staleContentByTemplate rather than
  // validating a second time, so this banner and the per-template indicator can
  // never disagree about which tokens are retired.
  // #2269 (second review): the page-level half of `stripped_annotation`.
  //
  // Before the migration these same rows raised the bracket banner at the top
  // of the page, so an admin saw them without opening every template. Reporting
  // the replacement only inside the open template would have been a strict LOSS
  // of signal on rows we ourselves rewrote — the specific regression this
  // banner exists to prevent — so it names them in the same place the bracket
  // banner did.
  //
  // It clears the moment the template is saved (see `untouchedSinceStrip`), so
  // reading the lines and pressing Save is a real acknowledgement rather than a
  // notice that never goes away.
  const strippedAnnotationOverrides = [...staleContentByTemplate.entries()]
    .filter(([, staleContent]) => staleContent.strippedAnnotations.length > 0)
    .map(([templateName, staleContent]) => ({
      templateName,
      annotations: staleContent.strippedAnnotations,
      lines: staleContent.unconditionalLines,
    }));

  const retiredTokenOverrides = [...overrideByTemplate.keys()]
    .map((templateName) => {
      const tokens = staleContentByTemplate.get(templateName)?.retiredTokens ?? [];
      if (tokens.length === 0) return null;
      return { templateName, tokens: Array.from(new Set(tokens)) };
    })
    .filter((entry): entry is { templateName: string; tokens: string[] } => entry !== null);

  return NextResponse.json({
    templates: EMAIL_TEMPLATE_DEFINITIONS.map((definition) => {
      const override = overrideByTemplate.get(definition.key);
      return {
        ...definition,
        override: override ? serializeOverride(override) : null,
        staleContent: staleContentByTemplate.get(definition.key) ?? null,
      };
    }),
    staleOverrideCount: staleOverrides.length,
    staleOverrides,
    bracketAnnotationOverrides,
    strippedAnnotationOverrides,
    retiredTokenOverrides,
    missingRequiredTokenOverrides,
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = templateUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  const validation = validateEmailTemplateContent({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject ?? "",
    bodyText: parsed.data.bodyText ?? "",
  });
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "Invalid email template",
        issues: validation.issues,
        unknownTokens: validation.unknownTokens,
        disallowedTokens: validation.disallowedTokens,
        missingRequiredTokens: validation.missingRequiredTokens,
        // #2774: both halves of the subject rule travel back named, so the editor can
        // point at the field rather than only printing the message.
        missingRequiredSubjectTokens: validation.missingRequiredSubjectTokens,
        forbiddenSubjectPhrases: validation.forbiddenSubjectPhrases,
        signPrefixedTokens: validation.signPrefixedTokens,
        sensitiveSubjectTokens: validation.sensitiveSubjectTokens,
        unsafeLinks: validation.unsafeLinks,
        bracketAnnotations: validation.bracketAnnotations,
      },
      { status: 400 },
    );
  }

  const update = {
    subject: parsed.data.subject || null,
    bodyText: parsed.data.bodyText || null,
    updatedByMemberId: session.user.id,
  };
  const before = await prisma.emailTemplateOverride.findUnique({
    where: { templateName: parsed.data.templateName },
  });

  const record = await prisma.emailTemplateOverride.upsert({
    where: { templateName: parsed.data.templateName },
    create: {
      templateName: parsed.data.templateName,
      ...update,
    },
    update,
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "EmailTemplateOverride",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email template override updated",
      metadata: {
        templateName: parsed.data.templateName,
        previousOverride: before,
        newOverride: update,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ override: record });
}
