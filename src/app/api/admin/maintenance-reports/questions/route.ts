import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit-http";
import logger from "@/lib/logger";
import {
  MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH,
  MAX_MAINTENANCE_QUESTION_CHOICES,
  MAX_MAINTENANCE_QUESTION_HELP_LENGTH,
  MAX_MAINTENANCE_QUESTION_LABEL_LENGTH,
  MAX_MAINTENANCE_QUESTIONS,
} from "@/lib/maintenance-reports";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

/**
 * The BOUNDED question-set editor (#2780, owner decision 2 — "a bounded editor,
 * not a general form builder"). Club-wide. Lodge Operations `view`/`edit`.
 *
 * WHAT MAKES IT BOUNDED, in enforcement rather than in wording: at most
 * `MAX_MAINTENANCE_QUESTIONS` questions, four answer types and no fifth, a label
 * and optional help text with hard lengths, a required flag, an order, and for a
 * single-choice question a short list of options. There is no branching, no
 * validation expression, no calculated field and no per-lodge variant.
 *
 * A QUESTION IS NEVER HARD-DELETED, and that is what makes submitted reports
 * survive an edit. PUT reconciles the submitted set against the stored one:
 * questions present are created or updated, questions absent are DEACTIVATED
 * (`active: false`). A deactivated question stops being asked immediately and
 * keeps its rows, so the answers that reference it still resolve. Answers snapshot
 * the label anyway (`MaintenanceReportAnswer.questionLabel`), so even a renamed
 * question cannot rewrite history — the deactivate-instead-of-delete rule is the
 * second line of defence, not the first.
 */

const questionInputSchema = z
  .object({
    // Absent on a question being added; present on one being edited. A client
    // cannot invent an id that is not already in the set — see the PUT handler.
    id: z.string().trim().max(64).optional(),
    label: z.string().trim().min(1).max(MAX_MAINTENANCE_QUESTION_LABEL_LENGTH),
    helpText: z
      .string()
      .trim()
      .max(MAX_MAINTENANCE_QUESTION_HELP_LENGTH)
      .optional()
      .nullable(),
    type: z.enum(["SHORT_TEXT", "LONG_TEXT", "YES_NO", "SINGLE_CHOICE"]),
    required: z.boolean(),
    choices: z
      .array(z.string().trim().min(1).max(MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH))
      .max(MAX_MAINTENANCE_QUESTION_CHOICES)
      .optional()
      .default([]),
  })
  .strict();

const putSchema = z
  .object({
    questions: z.array(questionInputSchema).max(MAX_MAINTENANCE_QUESTIONS),
  })
  .strict();

const QUESTION_SELECT = {
  id: true,
  label: true,
  helpText: true,
  type: true,
  required: true,
  choices: true,
  sortOrder: true,
  active: true,
} as const;

export async function GET() {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const questions = await prisma.maintenanceReportQuestion.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: QUESTION_SELECT,
  });

  return NextResponse.json({
    questions,
    limits: {
      maxQuestions: MAX_MAINTENANCE_QUESTIONS,
      maxLabelLength: MAX_MAINTENANCE_QUESTION_LABEL_LENGTH,
      maxHelpLength: MAX_MAINTENANCE_QUESTION_HELP_LENGTH,
      maxChoices: MAX_MAINTENANCE_QUESTION_CHOICES,
      maxChoiceLength: MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH,
    },
  });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check the questions and try again." },
      { status: 400 },
    );
  }

  // A single-choice question with no options is unanswerable: the submit service
  // refuses every value against an empty `choices`, so accepting it here would
  // ship a form nobody can complete. Refused at the write, where it is fixable.
  for (const question of parsed.data.questions) {
    if (question.type === "SINGLE_CHOICE" && question.choices.length < 2) {
      return NextResponse.json(
        {
          error: `"${question.label}" is a choice question, so it needs at least two options.`,
        },
        { status: 400 },
      );
    }
    if (question.type !== "SINGLE_CHOICE" && question.choices.length > 0) {
      return NextResponse.json(
        { error: `"${question.label}" only takes options when it is a choice question.` },
        { status: 400 },
      );
    }
    const unique = new Set(question.choices);
    if (unique.size !== question.choices.length) {
      return NextResponse.json(
        { error: `"${question.label}" has the same option twice.` },
        { status: 400 },
      );
    }
  }

  try {
    const existing = await prisma.maintenanceReportQuestion.findMany({
      where: { active: true },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((row) => row.id));

    // An id the caller sent that is not in the ACTIVE set is treated as a new
    // question rather than trusted. Without this, a payload naming an inactive or
    // foreign id would resurrect or overwrite a row the editor never showed.
    const keptIds = new Set(
      parsed.data.questions
        .map((question) => question.id)
        .filter((id): id is string => Boolean(id && existingIds.has(id))),
    );

    await prisma.$transaction(async (tx) => {
      for (const [index, question] of parsed.data.questions.entries()) {
        const data = {
          label: question.label,
          helpText: question.helpText?.trim() || null,
          type: question.type,
          required: question.required,
          choices: question.type === "SINGLE_CHOICE" ? question.choices : [],
          sortOrder: index,
          active: true,
        };

        if (question.id && keptIds.has(question.id)) {
          await tx.maintenanceReportQuestion.update({
            where: { id: question.id },
            data,
          });
        } else {
          await tx.maintenanceReportQuestion.create({ data });
        }
      }

      const removed = [...existingIds].filter((id) => !keptIds.has(id));
      if (removed.length > 0) {
        // DEACTIVATE, never delete. See the module docblock.
        await tx.maintenanceReportQuestion.updateMany({
          where: { id: { in: removed } },
          data: { active: false },
        });
      }
    });

    logAudit({
      action: "maintenance.questions.updated",
      category: "lodge",
      memberId: admin.session.user.id,
      entityType: "MaintenanceReportQuestion",
      details: JSON.stringify({
        questionCount: parsed.data.questions.length,
        deactivated: [...existingIds].filter((id) => !keptIds.has(id)).length,
      }),
      ipAddress: getClientIp(request),
      outcome: "success",
    });

    const questions = await prisma.maintenanceReportQuestion.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: QUESTION_SELECT,
    });

    return NextResponse.json({ questions });
  } catch (err) {
    logger.error({ err }, "Failed to save maintenance report questions");
    return NextResponse.json(
      { error: "Failed to save the questions" },
      { status: 500 },
    );
  }
}
