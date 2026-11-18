"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import { apiRefusalFromResponse } from "@/lib/api-error-message";
import {
  MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH,
  MAX_MAINTENANCE_QUESTION_CHOICES,
  MAX_MAINTENANCE_QUESTION_HELP_LENGTH,
  MAX_MAINTENANCE_QUESTION_LABEL_LENGTH,
  MAX_MAINTENANCE_QUESTIONS,
} from "@/lib/maintenance-report-limits";

const LOAD_FALLBACK = "Failed to load the questions";
const SAVE_FALLBACK = "Failed to save the questions";

/**
 * The bounded question-set editor (#2780, owner decision 2: "a bounded editor,
 * not a general form builder"). Club-wide. Lodge Operations.
 *
 * WHAT BOUNDED MEANS HERE, and why it is a feature rather than a limitation: an
 * admin sets a label, an answer type from four, whether it must be answered, some
 * help text, and — for a choice question — the options. There is no branching, no
 * conditional visibility, no calculated field and no expression language. A club
 * that can build arbitrary forms builds one nobody can read, and every question
 * added is a question somebody standing in front of a broken pipe has to answer
 * before they can tell you about it. The limits are the server's
 * (`MAX_MAINTENANCE_*`), imported rather than restated, so this editor cannot
 * promise something the write endpoint will refuse.
 *
 * REMOVING A QUESTION IS NOT A DELETION, and the copy says so where it matters.
 * The endpoint deactivates: the question stops being asked immediately, and every
 * report already submitted keeps its answers, which store the question text AS
 * ASKED. So an admin editing this set can never rewrite the history of what a
 * member was asked — the copy beside Remove exists because an admin who believes
 * otherwise will hesitate to tidy a form they should be tidying.
 *
 * ONE SAVE FOR THE WHOLE SET. The draft holds an array, so this section passes its
 * own deep `isDirty` (the hook's default shallow compare is by-reference on an
 * array and would call an edited set pristine).
 */

type QuestionType = "SHORT_TEXT" | "LONG_TEXT" | "YES_NO" | "SINGLE_CHOICE";

type EditableQuestion = {
  /** Absent on a question that has not been saved yet. */
  id?: string;
  label: string;
  helpText: string;
  type: QuestionType;
  required: boolean;
  choices: string[];
};

type Draft = { questions: EditableQuestion[] };

type ServerQuestion = {
  id: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  required: boolean;
  choices: string[];
};

const ENDPOINT = "/api/admin/maintenance-reports/questions";

const TYPE_LABELS: Record<QuestionType, string> = {
  SHORT_TEXT: "A short line of text",
  LONG_TEXT: "A longer description",
  YES_NO: "Yes or no",
  SINGLE_CHOICE: "One of a list you set",
};

function toDraft(questions: ServerQuestion[]): Draft {
  return {
    questions: questions.map((question) => ({
      id: question.id,
      label: question.label,
      helpText: question.helpText ?? "",
      type: question.type,
      required: question.required,
      choices: [...question.choices],
    })),
  };
}

/** Deep, because the draft holds an array — see the module docblock. */
function questionsDiffer(a: Draft, b: Draft): boolean {
  return JSON.stringify(a.questions) !== JSON.stringify(b.questions);
}

function isValidDraft(draft: Draft): boolean {
  if (draft.questions.length > MAX_MAINTENANCE_QUESTIONS) return false;
  return draft.questions.every((question) => {
    if (!question.label.trim()) return false;
    if (question.label.trim().length > MAX_MAINTENANCE_QUESTION_LABEL_LENGTH) {
      return false;
    }
    if (question.helpText.length > MAX_MAINTENANCE_QUESTION_HELP_LENGTH) {
      return false;
    }
    if (question.type !== "SINGLE_CHOICE") return true;
    // Mirrors the server's rule rather than a softer one, so Save is only offered
    // when the write will be accepted.
    const filled = question.choices.map((choice) => choice.trim()).filter(Boolean);
    return filled.length >= 2 && new Set(filled).size === filled.length;
  });
}

export function MaintenanceQuestionsSection() {
  const canEdit = useAdminAreaEditAccess("lodge");

  const section = useSectionEditState<Draft>({
    load: async (signal) => {
      const res = await fetch(ENDPOINT, { signal });
      if (!res.ok) throw new Error(LOAD_FALLBACK);
      return toDraft(((await res.json()) as { questions: ServerQuestion[] }).questions);
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions: draft.questions.map((question) => ({
            ...(question.id ? { id: question.id } : {}),
            label: question.label.trim(),
            helpText: question.helpText.trim() || null,
            type: question.type,
            required: question.required,
            choices:
              question.type === "SINGLE_CHOICE"
                ? question.choices.map((choice) => choice.trim()).filter(Boolean)
                : [],
          })),
        }),
      });
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError();
        throw await apiRefusalFromResponse(res, SAVE_FALLBACK);
      }
      return toDraft(((await res.json()) as { questions: ServerQuestion[] }).questions);
    },
    successMessage: "Questions saved",
    loadErrorFallback: LOAD_FALLBACK,
    saveErrorFallback: SAVE_FALLBACK,
    isDirty: questionsDiffer,
    isValid: isValidDraft,
  });

  const { draft, editing, saving, dirty, error, success } = section;
  const readOnly = !editing;

  const update = (index: number, patch: Partial<EditableQuestion>) =>
    section.setDraft((current) => ({
      questions: current.questions.map((question, position) =>
        position === index ? { ...question, ...patch } : question,
      ),
    }));

  const move = (index: number, delta: number) =>
    section.setDraft((current) => {
      const next = [...current.questions];
      const target = index + delta;
      const moving = next[index];
      const displaced = next[target];
      if (!moving || !displaced) return current;
      next[index] = displaced;
      next[target] = moving;
      return { questions: next };
    });

  const remove = (index: number) =>
    section.setDraft((current) => ({
      questions: current.questions.filter((_, position) => position !== index),
    }));

  const add = () =>
    section.setDraft((current) => ({
      questions: [
        ...current.questions,
        {
          label: "",
          helpText: "",
          type: "SHORT_TEXT",
          required: false,
          choices: [],
        },
      ],
    }));

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      You can see the questions but not change them. Ask an administrator with Lodge
      Operations access if a question needs adding, rewording or removing.
    </AdminViewOnlySectionBanner>
  );

  const feedback = (
    <PolicyFeedback
      error={error}
      success={success}
      onClearError={() => section.setError("")}
      onClearSuccess={() => section.setSuccess("")}
    />
  );

  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card {...section.sectionRegionProps}>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle {...section.titleProps}>What the form asks</CardTitle>
            <CardDescription>
              Both the members&apos; form and the QR one ask these, in this order,
              after &quot;what needs fixing?&quot;. Up to {MAX_MAINTENANCE_QUESTIONS}.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
              {...section.editTriggerProps}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {draft.questions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No extra questions. The form still asks what needs fixing, which lodge
              it is about, and offers a photo — so it works with none of these.
            </p>
          ) : null}

          {draft.questions.map((question, index) => (
            <div
              key={question.id ?? `new-${index}`}
              className="space-y-3 rounded-md border p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 space-y-2">
                  <Label htmlFor={`maintenance-question-${index}`}>
                    Question {index + 1}
                  </Label>
                  <Input
                    id={`maintenance-question-${index}`}
                    value={question.label}
                    disabled={readOnly}
                    maxLength={MAX_MAINTENANCE_QUESTION_LABEL_LENGTH}
                    placeholder="For example: which room or area is it in?"
                    onChange={(event) => update(index, { label: event.target.value })}
                  />
                </div>
                {editing ? (
                  <div className="flex shrink-0 gap-1 pt-7">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move question ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move question ${index + 1} down`}
                      disabled={index === draft.questions.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove question ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`maintenance-question-type-${index}`}>
                    Answer type
                  </Label>
                  <Select
                    value={question.type}
                    disabled={readOnly}
                    onValueChange={(next) =>
                      update(index, {
                        type: next as QuestionType,
                        // Options only mean anything on a choice question, and
                        // leaving stale ones behind would send them to a server that
                        // refuses options on any other type.
                        choices: next === "SINGLE_CHOICE" ? question.choices : [],
                      })
                    }
                  >
                    <SelectTrigger id={`maintenance-question-type-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TYPE_LABELS) as QuestionType[]).map((type) => (
                        <SelectItem key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`maintenance-question-help-${index}`}>
                    Help text (optional)
                  </Label>
                  <Input
                    id={`maintenance-question-help-${index}`}
                    value={question.helpText}
                    disabled={readOnly}
                    maxLength={MAX_MAINTENANCE_QUESTION_HELP_LENGTH}
                    onChange={(event) =>
                      update(index, { helpText: event.target.value })
                    }
                  />
                </div>
              </div>

              {question.type === "SINGLE_CHOICE" ? (
                <div className="space-y-2">
                  <Label>Options (at least two, all different)</Label>
                  {question.choices.map((choice, choiceIndex) => (
                    <div key={choiceIndex} className="flex gap-2">
                      <Input
                        value={choice}
                        disabled={readOnly}
                        maxLength={MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH}
                        aria-label={`Option ${choiceIndex + 1} for question ${index + 1}`}
                        onChange={(event) =>
                          update(index, {
                            choices: question.choices.map((existing, position) =>
                              position === choiceIndex ? event.target.value : existing,
                            ),
                          })
                        }
                      />
                      {editing ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove option ${choiceIndex + 1} from question ${index + 1}`}
                          onClick={() =>
                            update(index, {
                              choices: question.choices.filter(
                                (_, position) => position !== choiceIndex,
                              ),
                            })
                          }
                        >
                          <Trash2
                            className="h-4 w-4 text-destructive"
                            aria-hidden="true"
                          />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  {editing ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        question.choices.length >= MAX_MAINTENANCE_QUESTION_CHOICES
                      }
                      onClick={() =>
                        update(index, { choices: [...question.choices, ""] })
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                      Add an option
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-start gap-2">
                <Checkbox
                  id={`maintenance-question-required-${index}`}
                  checked={question.required}
                  disabled={readOnly}
                  onCheckedChange={(checked) =>
                    update(index, { required: checked === true })
                  }
                />
                <Label
                  htmlFor={`maintenance-question-required-${index}`}
                  className="leading-snug"
                >
                  It has to be answered
                  <span className="block text-xs font-normal text-muted-foreground">
                    Think twice: somebody standing in front of a broken thing has to
                    answer it before they can tell you anything at all.
                  </span>
                </Label>
              </div>
            </div>
          ))}

          {editing ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.questions.length >= MAX_MAINTENANCE_QUESTIONS}
                onClick={add}
              >
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Add a question
              </Button>

              <p className="text-xs text-muted-foreground">
                Removing a question stops it being asked from the moment you save.
                Reports already sent in keep their answers, and keep the wording they
                were asked under — editing this list never changes what an old report
                says.
              </p>

              <div className="flex gap-2">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => void section.save()}
                  disabled={!dirty || saving || !section.valid}
                >
                  {saving ? "Saving..." : "Save"}
                </ViewOnlyActionButton>
                <Button
                  variant="outline"
                  onClick={section.cancelEditing}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
