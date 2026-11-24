"use client";

import { useRef, useState } from "react";
import type {
  SubscriptionLiabilityAgeSource,
  SubscriptionRequiredTypeAgeRule,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Radio } from "@/components/ui/radio";
import { FocusedActionError } from "@/components/focused-action-error";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAccessToAll } from "@/hooks/use-admin-area-edit-access";
import {
  saveRefusalFromResponse,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  apiErrorMessageFromResponse,
  apiRefusalFromResponse,
} from "@/lib/api-error-message";
import {
  hasChosenLiabilityRule,
  isChoosableLiabilityAgeSource,
  LIABILITY_RULE_CHOICE_PERMISSIONS,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import { subscriptionStatusLabel } from "@/lib/status-colors";
import type { SubscriptionLiabilityImpact } from "@/lib/subscription-liability-impact";

/**
 * Who owes a subscription: the club's liability rule (#5190, `INV-CONFIG-009`).
 *
 * Billing (who is invoiced) and booking access (who must pay before booking)
 * ask one rule, made of two answers the club chooses together. Until it does,
 * the club is on "Not chosen", which keeps the two old rules. This section
 * shows the rule in plain English and lets an admin choose or change it.
 *
 * Choosing moves money, so Save is reachable only through a preview: the
 * `liability-impact` list of who would start owing, who would stop, and which
 * saved "Not required" records the save would reset. Save stays disabled until
 * a preview of exactly the answers on screen has loaded, and changing an answer
 * after previewing asks for a fresh one. The reset list is the clear-up's own
 * selection (`findStaleNotRequiredRows`), so it names the rows the save resets.
 *
 * Choosing needs Membership edit AND Finance edit (owner decision 23 Nov 2026),
 * which the route enforces; the section's view-only banner says so. Follows the
 * canonical settings-section pattern (`useSectionEditState`): read-only on
 * mount, Edit reveals the controls, Cancel reverts, Save writes once and sends
 * only the pair, so it can never touch the lockout panel's other settings.
 */

const ENDPOINT = "/api/admin/membership-lockout-settings";
const IMPACT_ENDPOINT = "/api/admin/membership-lockout-settings/liability-impact";
const LOAD_FALLBACK = "Failed to load the subscription liability rule";
const SAVE_FALLBACK = "Failed to save the subscription liability rule";
const PREVIEW_FALLBACK = "Could not work out who this rule would change. Try again.";

type ChoosableRequiredTypeAgeRule = Exclude<SubscriptionRequiredTypeAgeRule, "NOT_CHOSEN">;
type ShownAgeSource = Exclude<SubscriptionLiabilityAgeSource, "NOT_CHOSEN">;

const REQUIRED_TYPE_AGE_RULE_OPTIONS: ReadonlyArray<{
  value: ChoosableRequiredTypeAgeRule;
  label: string;
  description: string;
}> = [
  {
    value: "ALWAYS_OWES",
    label: "They still owe",
    description:
      "The membership type decides. A child on an always-required type is invoiced, and must pay before booking while the booking lockout is on.",
  },
  {
    value: "AGE_TIER_EXEMPTS",
    label: "Their age group exempts them",
    description:
      "The age group decides. A member in an age group that needs no subscription is neither invoiced nor asked to pay before booking, whatever their membership type.",
  },
];

/**
 * Every age source, in the order offered. "Age today" is listed but cannot be
 * chosen until part-season invoices exist (#5190's third pull request);
 * `isChoosableLiabilityAgeSource` decides, so this list needs no edit then.
 */
const AGE_SOURCE_OPTIONS: ReadonlyArray<{
  value: ShownAgeSource;
  label: string;
  description: string;
}> = [
  {
    value: "SEASON_START",
    label: "Their age on the first day of the season",
    description:
      "A member who has a birthday during the season keeps the age group they started it in until next season.",
  },
  {
    value: "SEASON_END",
    label: "Their age on the last day of the season",
    description:
      "A member who moves up an age group during the season owes for the whole season, from its first day.",
  },
  {
    value: "CURRENT_AGE",
    label: "Their age today",
    description:
      "Not available yet: it needs part-season invoices for a member who moves up an age group during the season.",
  },
];

function labelOf<T extends string>(
  options: ReadonlyArray<{ value: T; label: string }>,
  value: string,
): string | null {
  return options.find((option) => option.value === value)?.label ?? null;
}

function pairKey(pair: SubscriptionLiabilitySettings): string {
  return `${pair.requiredTypeAgeRule}|${pair.liabilityAgeSource}`;
}

function toPair(settings: SubscriptionLiabilitySettings): SubscriptionLiabilitySettings {
  return {
    requiredTypeAgeRule: settings.requiredTypeAgeRule,
    liabilityAgeSource: settings.liabilityAgeSource,
  };
}

interface LoadedPreview {
  key: string;
  impact: SubscriptionLiabilityImpact;
  invoiceNumbersShown: boolean;
}

export function SubscriptionLiabilityRuleSection() {
  // The list the route enforces (membership edit AND finance edit); undecided
  // while the session resolves.
  const canEdit = useAdminAccessToAll(LIABILITY_RULE_CHOICE_PERMISSIONS);

  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // What the last save reset, against what its preview listed, for the
  // success message.
  const lastSave = useRef<{ cleared: number; previewed: number } | null>(null);
  // Bumped by each preview request and by Cancel, so a reply that lands after
  // a newer request, or after Cancel, is dropped rather than shown.
  const previewRequest = useRef(0);

  const section = useSectionEditState<SubscriptionLiabilitySettings>({
    load: async (signal) => {
      const res = await fetch(ENDPOINT, { signal, credentials: "same-origin" });
      if (!res.ok) throw await apiRefusalFromResponse(res, LOAD_FALLBACK);
      const body = (await res.json()) as { settings: SubscriptionLiabilitySettings };
      return toPair(body.settings);
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        // Only the pair: every other lockout setting is left as stored.
        body: JSON.stringify({
          requiredTypeAgeRule: draft.requiredTypeAgeRule,
          liabilityAgeSource: draft.liabilityAgeSource,
        }),
      });
      if (!res.ok) throw await saveRefusalFromResponse(res, SAVE_FALLBACK);
      const body = (await res.json()) as {
        settings: SubscriptionLiabilitySettings;
        clearedStaleRecords: number | null;
      };
      lastSave.current = {
        cleared: body.clearedStaleRecords ?? 0,
        previewed: preview?.impact.staleRecords.length ?? 0,
      };
      setPreview(null);
      return toPair(body.settings);
    },
    successMessage: () => saveMessage(lastSave.current),
    loadErrorFallback: LOAD_FALLBACK,
    saveErrorFallback: SAVE_FALLBACK,
    // Save only what was previewed: both answers chosen, and the preview on
    // screen is of exactly these answers.
    isValid: (draft) =>
      hasChosenLiabilityRule(draft) && preview?.key === pairKey(draft),
  });

  const { draft, saved, editing, saving, dirty, error, success } = section;

  async function loadPreview() {
    if (!draft || !hasChosenLiabilityRule(draft)) return;
    const key = pairKey(draft);
    const request = ++previewRequest.current;
    const current = () => request === previewRequest.current;
    setPreviewing(true);
    setPreviewError("");
    try {
      const query = new URLSearchParams({
        requiredTypeAgeRule: draft.requiredTypeAgeRule,
        liabilityAgeSource: draft.liabilityAgeSource,
      });
      const res = await fetch(`${IMPACT_ENDPOINT}?${query.toString()}`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        const message = await apiErrorMessageFromResponse(res, PREVIEW_FALLBACK);
        if (!current()) return;
        setPreview(null);
        setPreviewError(message);
        return;
      }
      const body = (await res.json()) as {
        impact: SubscriptionLiabilityImpact;
        invoiceNumbersShown: boolean;
      };
      if (!current()) return;
      setPreview({ key, impact: body.impact, invoiceNumbersShown: body.invoiceNumbersShown });
    } catch {
      if (!current()) return;
      setPreview(null);
      setPreviewError(PREVIEW_FALLBACK);
    } finally {
      if (current()) setPreviewing(false);
    }
  }

  function cancel() {
    previewRequest.current += 1;
    setPreview(null);
    setPreviewing(false);
    setPreviewError("");
    // A failed save's message belongs to the editor being closed.
    section.setError("");
    section.cancelEditing();
  }

  // The view-only reason, once, at the top of the section and in every state
  // (see group-discount-section.tsx for the screen-reader reasoning).
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view the subscription liability rule but cannot change
      it. Choosing it needs both Membership edit and Finance edit access,
      because it changes who is invoiced.
    </AdminViewOnlySectionBanner>
  );
  // While the editor is open, a failed save is shown beside its buttons (below
  // a long preview, the top of the section can be off screen); otherwise, such
  // as a failed load, at the top.
  const feedback = (
    <PolicyFeedback
      error={editing ? "" : error}
      success={success}
      onClearError={() => section.setError("")}
      onClearSuccess={() => section.setSuccess("")}
    />
  );

  if (section.loading || !draft || !saved) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <p className="text-sm text-muted-foreground">Loading the liability rule…</p>
        ) : null}
      </div>
    );
  }

  const draftChosen = hasChosenLiabilityRule(draft);
  const previewCurrent = preview !== null && preview.key === pairKey(draft);

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card {...section.sectionRegionProps}>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle {...section.titleProps} headingLevel={2}>Who owes a subscription</CardTitle>
            <CardDescription>
              One rule decides both who is invoiced for a subscription and who
              must pay before booking.
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
              {hasChosenLiabilityRule(saved) ? "Change rule" : "Choose rule"}
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {editing ? (
            <RuleQuestions
              draft={draft}
              onChange={(patch) => section.setDraft(patch)}
            />
          ) : (
            <CurrentRule saved={saved} />
          )}

          {editing && preview !== null ? (
            previewCurrent ? (
              <LiabilityPreview
                impact={preview.impact}
                invoiceNumbersShown={preview.invoiceNumbersShown}
              />
            ) : (
              <p className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                Your answers have changed since this preview. Preview again
                before saving.
              </p>
            )
          ) : null}

          <FocusedActionError
            id="subscription-liability-action-error"
            error={editing ? error || previewError : ""}
          />

          {editing ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={loadPreview}
                disabled={!draftChosen || !dirty || previewing || saving}
              >
                {previewing ? "Working out who changes…" : "Preview changes"}
              </Button>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={section.save}
                disabled={!dirty || !previewCurrent || saving}
              >
                {saving ? "Saving…" : "Save rule"}
              </ViewOnlyActionButton>
              <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The confirmation after a save. The preview was read earlier, so records can
 * have moved in between (another officer's save, an invoice, a new
 * assignment); when the count differs from the one previewed, it says so.
 */
function saveMessage(save: { cleared: number; previewed: number } | null): string {
  const saved = "Rule saved. Billing and booking now both follow it.";
  if (save === null || (save.cleared === 0 && save.previewed === 0)) return saved;
  const reset = `${save.cleared} "Not required" ${save.cleared === 1 ? "record was" : "records were"} reset to Not Invoiced.`;
  return save.cleared === save.previewed
    ? `${saved} ${reset}`
    : `${saved} ${reset} The preview listed ${save.previewed}: records changed between the preview and the save.`;
}

/** The saved rule, read-only, in plain English. */
function CurrentRule({ saved }: { saved: SubscriptionLiabilitySettings }) {
  if (!hasChosenLiabilityRule(saved)) {
    return (
      <div className="space-y-2 rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
        <p className="font-medium">Not chosen yet</p>
        <p>
          Billing and booking still use their old rules, which can disagree.
          Billing invoices a child on an always-required membership type, but
          booking lets them book without paying. Booking lets a member with a
          saved &ldquo;Not required&rdquo; record book without paying, even when
          billing invoices them.
        </p>
        <p>Choose a rule so that both follow one answer. Nothing changes until you do.</p>
      </div>
    );
  }
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="font-medium">
          A member on an always-required membership type whose age group needs no subscription
        </dt>
        <dd className="text-muted-foreground">
          {labelOf(REQUIRED_TYPE_AGE_RULE_OPTIONS, saved.requiredTypeAgeRule)}
        </dd>
      </div>
      <div>
        <dt className="font-medium">The age that decides a member&rsquo;s age group</dt>
        <dd className="text-muted-foreground">
          {labelOf(AGE_SOURCE_OPTIONS, saved.liabilityAgeSource)}
        </dd>
      </div>
      <p className="text-xs text-muted-foreground">
        A saved &ldquo;Not required&rdquo; record no longer exempts anyone on its
        own: age and membership type decide. The rule can be changed, but not set
        back to Not chosen.
      </p>
    </dl>
  );
}

/** The two questions, with the help text an officer needs to answer them. */
function RuleQuestions({
  draft,
  onChange,
}: {
  draft: SubscriptionLiabilitySettings;
  onChange: (patch: Partial<SubscriptionLiabilitySettings>) => void;
}) {
  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          A member is on an always-required membership type, but their age
          group needs no subscription. Do they owe one?
        </legend>
        <p className="text-xs text-muted-foreground">
          For example, Sam is 10 and on the Full type, which always needs a
          subscription, and your Child age group needs none. Under &ldquo;They
          still owe&rdquo;, Sam is invoiced and must pay before booking. Under
          &ldquo;Their age group exempts them&rdquo;, Sam is neither.
        </p>
        {REQUIRED_TYPE_AGE_RULE_OPTIONS.map((option) => (
          <label
            key={option.value}
            htmlFor={`subscription-liability-rule-${option.value}`}
            className="flex items-start gap-3"
          >
            <Radio
              id={`subscription-liability-rule-${option.value}`}
              className="mt-0.5"
              name="subscription-liability-required-type-age-rule"
              value={option.value}
              checked={draft.requiredTypeAgeRule === option.value}
              onChange={() => onChange({ requiredTypeAgeRule: option.value })}
            />
            <span className="text-sm">
              <span className="font-medium">{option.label}</span>
              <span className="block text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          Which age decides a member&rsquo;s age group?
        </legend>
        <p className="text-xs text-muted-foreground">
          A member with no date of birth on file keeps the age group stored on
          their record.
        </p>
        {AGE_SOURCE_OPTIONS.map((option) => {
          const choosable = isChoosableLiabilityAgeSource(option.value);
          return (
            <label
              key={option.value}
              htmlFor={`subscription-liability-age-${option.value}`}
              className="flex items-start gap-3"
            >
              <Radio
                id={`subscription-liability-age-${option.value}`}
                className="mt-0.5"
                name="subscription-liability-age-source"
                value={option.value}
                checked={draft.liabilityAgeSource === option.value}
                disabled={!choosable}
                onChange={() => onChange({ liabilityAgeSource: option.value })}
              />
              <span className={`text-sm ${choosable ? "" : "text-muted-foreground"}`}>
                <span className="font-medium">{option.label}</span>
                <span className="block text-muted-foreground">{option.description}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <p className="text-xs text-muted-foreground">
        Once a rule is chosen, a saved &ldquo;Not required&rdquo; record no
        longer exempts anyone on its own. Saving resets each such record whose
        member now owes to Not Invoiced, so the next billing run can invoice
        them. A chosen rule can be changed later, but not set back to Not
        chosen. Preview the changes before you save.
      </p>
    </div>
  );
}

/** Who the previewed rule changes, as the `liability-impact` list reports it. */
function LiabilityPreview({
  impact,
  invoiceNumbersShown,
}: {
  impact: SubscriptionLiabilityImpact;
  invoiceNumbersShown: boolean;
}) {
  const nobody =
    impact.newlyOwing.length === 0 &&
    impact.noLongerOwing.length === 0 &&
    impact.staleRecords.length === 0;
  return (
    <section
      aria-labelledby="subscription-liability-preview-heading"
      className="space-y-4 rounded-md border border-border p-4"
    >
      <h3 id="subscription-liability-preview-heading" className="text-sm font-semibold">
        If you save this rule, for the {impact.seasonYear} season
      </h3>
      {nobody ? (
        <p className="text-sm text-muted-foreground">
          Nobody&rsquo;s subscription changes, and no records are reset.
        </p>
      ) : null}

      <PreviewList
        title="Would start owing"
        explanation="Billing invoices them at its next run, or booking asks them to pay first, or both."
        rows={impact.newlyOwing.map((member) => ({
          key: member.memberId,
          name: member.name,
          detail: [
            member.billingChanges ? "newly invoiced" : null,
            member.accessChanges ? "must pay before booking" : null,
          ],
        }))}
      />

      <PreviewList
        title="Would stop owing"
        explanation="Billing stops invoicing them, or booking stops asking them to pay first, or both. An unpaid invoice they already hold stays in Xero: void it there if it should not be paid."
        rows={impact.noLongerOwing.map((member) => ({
          key: member.memberId,
          name: member.name,
          detail: [
            member.billingChanges ? "no longer invoiced" : null,
            member.accessChanges ? "can book without paying" : null,
            member.unpaidInvoiceNumber ? `unpaid invoice ${member.unpaidInvoiceNumber}` : null,
          ],
        }))}
        footnote={
          !invoiceNumbersShown && impact.noLongerOwing.length > 0
            ? "Unpaid invoice numbers are shown only to admins with Finance access."
            : null
        }
      />

      <PreviewList
        title={"Saved “Not required” records that would be reset to Not Invoiced"}
        explanation="These members have a saved Not required record for this season, but under this rule they owe. Each row says what the members list shows for them today: a member billing already treats as owing shows as Not Invoiced with a “Marked not required” note. Saving resets each record to Not Invoiced, which removes the note, so the next billing run can invoice them. A record that is invoiced, paid, marked paid or covered by a no-invoice fee is never changed."
        rows={impact.staleRecords.map((record) => ({
          key: record.memberId,
          name: record.name,
          detail: [
            // #5190 (owner decision 22 Nov 2026): the members list's own status.
            record.listStatus
              ? `members list shows ${subscriptionStatusLabel(record.listStatus)}${
                  record.listNote ? ", with the “Marked not required” note" : ""
                }`
              : null,
            record.inBillingPopulation
              ? null
              : "inactive or archived: not invoiced unless made active again",
          ],
        }))}
      />
    </section>
  );
}

function PreviewList({
  title,
  explanation,
  rows,
  footnote = null,
}: {
  title: string;
  explanation: string;
  rows: Array<{ key: string; name: string; detail: Array<string | null> }>;
  footnote?: string | null;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium">
        {title} ({rows.length})
      </h4>
      <p className="text-xs text-muted-foreground">{explanation}</p>
      {/* Every row, never a sample: the officer is deciding on all of them. */}
      <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md bg-muted p-2 text-sm">
        {rows.map((row) => {
          const detail = row.detail.filter((part): part is string => part !== null);
          return (
            <li key={row.key}>
              <span className="font-medium">{row.name}</span>
              {detail.length > 0 ? (
                <span className="text-muted-foreground"> ({detail.join("; ")})</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {footnote ? <p className="text-xs text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}
