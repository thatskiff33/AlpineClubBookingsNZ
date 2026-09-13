"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input";
import {
  JoiningFeePreviewHint,
  useJoiningFeePrefill,
  useJoiningFeePreview,
} from "@/components/admin/joining-fee-preview";

// E10 (#1936): the extracted application-approval flow — per-person Create/Map
// decisions, candidate chips + live search, a field-by-field diff preview, the
// joining-fee block (SKIP default for a mapped applicant), and the Approve /
// Reject actions. The parent page owns the notify-choice dialog + dispatch; this
// panel produces the validated review payload and gates Approve on a fresh,
// zero-error preview whenever any person is mapped.

type PersonMode = "CREATE" | "MAP";

type ApplicationFamilyMember = {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
};

type PanelApplication = {
  id: string;
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  /** NZ date-only (YYYY-MM-DD) from the applications API — passed verbatim to
   * the joining-fee preview endpoint, whose schema is strictly date-only. */
  applicantDateOfBirth: string | null;
  familyMembers: ApplicationFamilyMember[];
};

type Candidate = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier?: string;
  active?: boolean;
  canLogin?: boolean;
  matchedOnEmail?: boolean;
};

type FieldDiff = {
  field: string;
  label: string;
  current: string | null;
  incoming: string | null;
  willChange: boolean;
};

type PersonRef = { kind: "applicant" } | { kind: "family"; index: number };

type PersonOutcome = {
  ref: PersonRef;
  personLabel: string;
  mode: PersonMode;
  targetMemberId: string | null;
  targetSummary: Candidate | null;
  fieldDiffs: FieldDiff[];
  notes: string[];
  errors: string[];
  suggestions: Candidate[];
};

type MappingPreview = {
  applicationId: string;
  persons: PersonOutcome[];
  blockingErrors: string[];
  hasMappings: boolean;
  previewToken: string;
};

type PersonSelection = {
  mode: PersonMode;
  member: Candidate | null;
};

type FeeForm = {
  action: "CREATE" | "SKIP";
  amount: string;
  narration: string;
  reason: string;
};

export type ReviewRequestPayload = {
  decision: "APPROVE" | "REJECT";
  entranceFeeInvoiceDecision: unknown;
  personDecisions: unknown;
  mappingPreviewToken: string | null;
};

const CREATE_FEE: FeeForm = { action: "CREATE", amount: "", narration: "", reason: "" };
const MAPPED_FEE: FeeForm = {
  action: "SKIP",
  amount: "",
  narration: "",
  reason: "Mapped to existing member",
};

function refKey(ref: PersonRef): string {
  return ref.kind === "applicant" ? "applicant" : `family:${ref.index}`;
}

function candidateLabel(candidate: Candidate) {
  return `${candidate.firstName} ${candidate.lastName}`.trim() || candidate.email;
}

export default function ApprovalMappingPanel({
  application,
  submitting,
  canEdit,
  onRequestReview,
  onError,
}: {
  application: PanelApplication;
  submitting: boolean;
  /** Whether the actor may approve/decline (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
  onRequestReview: (payload: ReviewRequestPayload) => void;
  onError: (message: string) => void;
}) {
  const [applicantSel, setApplicantSel] = useState<PersonSelection>({
    mode: "CREATE",
    member: null,
  });
  const [familySel, setFamilySel] = useState<PersonSelection[]>(
    application.familyMembers.map(() => ({ mode: "CREATE", member: null })),
  );
  const [fee, setFee] = useState<FeeForm>(CREATE_FEE);
  const [feeTouched, setFeeTouched] = useState(false);

  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [previewedSignature, setPreviewedSignature] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [searchKey, setSearchKey] = useState<string | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<string, string>>({});
  const [searchResults, setSearchResults] = useState<Record<string, Candidate[]>>({});

  const hasMappings =
    applicantSel.mode === "MAP" || familySel.some((sel) => sel.mode === "MAP");

  const personDecisions = useMemo(() => {
    return {
      applicant:
        applicantSel.mode === "MAP" && applicantSel.member
          ? { mode: "MAP" as const, memberId: applicantSel.member.id }
          : { mode: "CREATE" as const },
      family: familySel.map((sel) =>
        sel.mode === "MAP" && sel.member
          ? { mode: "MAP" as const, memberId: sel.member.id }
          : { mode: "CREATE" as const },
      ),
    };
  }, [applicantSel, familySel]);

  const decisionSignature = useMemo(
    () => JSON.stringify(personDecisions),
    [personDecisions],
  );

  const allMapTargetsChosen =
    (applicantSel.mode !== "MAP" || Boolean(applicantSel.member)) &&
    familySel.every((sel) => sel.mode !== "MAP" || Boolean(sel.member));

  const previewIsFresh = Boolean(
    preview && previewedSignature === decisionSignature,
  );
  const previewErrors = preview
    ? [
        ...preview.blockingErrors,
        ...preview.persons.flatMap((person) => person.errors),
      ]
    : [];

  // Approve is enabled only when: all mapped persons have a chosen target and,
  // if anything is mapped, a fresh preview with zero errors exists.
  const approveDisabled =
    submitting ||
    !allMapTargetsChosen ||
    (hasMappings && (!previewIsFresh || previewErrors.length > 0));

  const effectiveFee = applicantSel.mode === "MAP" && !feeTouched ? MAPPED_FEE : fee;

  // Item 15 (#1931, E5): surface the default joining fee for the not-yet-created
  // applicant via the preview lib's raw-inputs mode (an approved applicant
  // becomes a FULL member; the DOB resolves the age tier). The fetch runs only
  // while the fee action is CREATE, and the resolved default prefills the amount
  // + narration override fields so the admin overrides from an informed
  // baseline. Prefill never clobbers an admin edit and does not mark the fee as
  // touched, so it stays behaviour-preserving.
  const joiningFeePreview = useJoiningFeePreview({
    pathId: application.id,
    enabled: effectiveFee.action === "CREATE",
    inputs: application.applicantDateOfBirth
      ? { membershipTypeKey: "FULL", dateOfBirth: application.applicantDateOfBirth }
      : { membershipTypeKey: "FULL", ageTier: "ADULT" },
  });
  useJoiningFeePrefill({
    preview: joiningFeePreview.preview,
    prefillKey: application.id,
    amount: fee.amount,
    narration: fee.narration,
    setAmount: (value) => setFee((prev) => ({ ...prev, amount: value })),
    setNarration: (value) => setFee((prev) => ({ ...prev, narration: value })),
  });

  function updateApplicantMode(mode: PersonMode) {
    setApplicantSel((prev) => ({ mode, member: mode === "MAP" ? prev.member : null }));
    invalidatePreview();
    // A mapped applicant defaults the joining fee to SKIP; a created applicant
    // defaults to CREATE. The admin can still override (feeTouched).
    if (!feeTouched) {
      setFee(mode === "MAP" ? MAPPED_FEE : CREATE_FEE);
    }
  }

  function updateFamilyMode(index: number, mode: PersonMode) {
    setFamilySel((prev) =>
      prev.map((sel, i) =>
        i === index ? { mode, member: mode === "MAP" ? sel.member : null } : sel,
      ),
    );
    invalidatePreview();
  }

  function chooseApplicantMember(member: Candidate) {
    setApplicantSel({ mode: "MAP", member });
    invalidatePreview();
  }

  function chooseFamilyMember(index: number, member: Candidate) {
    setFamilySel((prev) =>
      prev.map((sel, i) => (i === index ? { mode: "MAP", member } : sel)),
    );
    invalidatePreview();
  }

  function invalidatePreview() {
    setPreview(null);
    setPreviewedSignature(null);
  }

  async function runPreview() {
    if (!allMapTargetsChosen) {
      onError("Choose an existing member for every person set to Map.");
      return;
    }
    setPreviewing(true);
    try {
      const response = await fetch(
        `/api/admin/member-applications/${application.id}/approval-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personDecisions }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        onError(data.error || "Could not build the mapping preview.");
        return;
      }
      setPreview(data.preview as MappingPreview);
      setPreviewedSignature(decisionSignature);
    } catch {
      onError("Could not build the mapping preview.");
    } finally {
      setPreviewing(false);
    }
  }

  async function searchMembers(key: string) {
    const query = (searchQueries[key] || "").trim();
    if (query.length < 2) {
      onError("Enter at least two characters to search for a member.");
      return;
    }
    setSearchKey(key);
    try {
      const response = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&active=true&pageSize=5`,
      );
      const data = await response.json();
      if (!response.ok) {
        onError(data.error || "Could not search members.");
        return;
      }
      setSearchResults((prev) => ({ ...prev, [key]: data.members || [] }));
    } catch {
      onError("Could not search members.");
    } finally {
      setSearchKey(null);
    }
  }

  function buildEntranceFeeInvoiceDecision(): { ok: true; value: unknown } | { ok: false } {
    if (effectiveFee.action === "SKIP") {
      const reason = effectiveFee.reason.trim();
      if (!reason) {
        onError("Enter a reason for not raising the joining fee invoice.");
        return { ok: false };
      }
      return { ok: true, value: { action: "SKIP", reason } };
    }
    const amountText = effectiveFee.amount.trim();
    let amountCents: number | undefined;
    if (amountText) {
      // #2685: the exact parser, so "12.345" and "12abc" are REFUSED here rather
      // than silently rounded or truncated into a joining-fee invoice.
      const parsedCents = parseDecimalDollarsToCents(amountText);
      if (parsedCents === null || parsedCents <= 0) {
        onError(
          "Enter a valid joining fee amount, or leave it blank to use the configured amount.",
        );
        return { ok: false };
      }
      amountCents = parsedCents;
    }
    return {
      ok: true,
      value: {
        action: "CREATE",
        ...(amountCents ? { amountCents } : {}),
        ...(effectiveFee.narration.trim()
          ? { narration: effectiveFee.narration.trim() }
          : {}),
      },
    };
  }

  function handleApprove() {
    if (hasMappings && (!previewIsFresh || previewErrors.length > 0)) {
      onError(
        "Preview the mapping and resolve any blocking issues before approving.",
      );
      return;
    }
    const fee = buildEntranceFeeInvoiceDecision();
    if (!fee.ok) return;
    onRequestReview({
      decision: "APPROVE",
      entranceFeeInvoiceDecision: fee.value,
      personDecisions: hasMappings ? personDecisions : null,
      mappingPreviewToken: hasMappings && preview ? preview.previewToken : null,
    });
  }

  function handleReject() {
    onRequestReview({
      decision: "REJECT",
      entranceFeeInvoiceDecision: undefined,
      personDecisions: null,
      mappingPreviewToken: null,
    });
  }

  const outcomeByRef = new Map<string, PersonOutcome>();
  for (const person of preview?.persons ?? []) {
    outcomeByRef.set(refKey(person.ref), person);
  }

  function renderPersonRow(
    ref: PersonRef,
    label: string,
    sel: PersonSelection,
    setMode: (mode: PersonMode) => void,
    chooseMember: (member: Candidate) => void,
  ) {
    const key = refKey(ref);
    const outcome = outcomeByRef.get(key);
    const results = searchResults[key] || [];
    const suggestions = outcome?.suggestions ?? [];
    return (
      <div key={key} className="rounded-lg border border-border bg-card p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-medium text-foreground">{label}</p>
          <div className="flex gap-2 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={`mode-${key}`}
                checked={sel.mode === "CREATE"}
                onChange={() => setMode("CREATE")}
              />
              Create new
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={`mode-${key}`}
                checked={sel.mode === "MAP"}
                onChange={() => setMode("MAP")}
              />
              Map to existing
            </label>
          </div>
        </div>

        {sel.mode === "MAP" && (
          <div className="mt-3 space-y-2">
            {sel.member ? (
              <div className="flex items-center justify-between rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm">
                <span>
                  Mapped to <strong>{candidateLabel(sel.member)}</strong>{" "}
                  <span className="text-muted-foreground">({sel.member.email})</span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => chooseMember({ ...sel.member! })}
                >
                  Change
                </Button>
              </div>
            ) : (
              <p className="text-sm text-warning-11">
                Choose an existing member below.
              </p>
            )}

            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`rounded-full border px-3 py-1 text-xs ${
                      sel.member?.id === candidate.id
                        ? "border-success-7 bg-success-3 text-success-11"
                        : "border-border bg-card text-muted-foreground hover:bg-accent"
                    }`}
                    onClick={() => chooseMember(candidate)}
                  >
                    {candidateLabel(candidate)}
                    {candidate.matchedOnEmail ? " · email match" : ""}
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              {/*
                #2264: a raw <input> with no label, no id and no aria-label —
                its placeholder was the accessible name, which is why the e2e
                spec had to reach it with `getByPlaceholder`. The name says what
                this box is FOR, deliberately different from the "Replacement
                member" box on the applications page itself: the two can render
                together, and two identically-named textboxes on one page are
                ambiguous to a screen reader and to Playwright alike. The
                placeholder stays — it is a search instruction, not an example
                value, so it belongs inside the control.

                The name is also PERSON-scoped. This row renders once per person
                on the application, so an applicant and three dependants all in
                MAP mode would otherwise put four identically-named search boxes
                on one page — exactly the ambiguity the name was added to
                remove. The shared prefix stays intact and contiguous, so
                Playwright's substring name matching still finds the box.
              */}
              <input
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
                aria-label={`Search for an existing member to map to, for ${label}`}
                value={searchQueries[key] || ""}
                onChange={(event) =>
                  setSearchQueries((prev) => ({ ...prev, [key]: event.target.value }))
                }
                placeholder="Search name or email"
              />
              <Button
                type="button"
                variant="outline"
                disabled={searchKey === key}
                onClick={() => searchMembers(key)}
              >
                {searchKey === key ? "Searching..." : "Search"}
              </Button>
            </div>

            {results.length > 0 && (
              <div className="space-y-1">
                {results.map((candidate) => (
                  <div
                    key={candidate.id}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span>
                      {candidateLabel(candidate)}{" "}
                      <span className="text-muted-foreground">{candidate.email}</span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => chooseMember(candidate)}
                    >
                      Use
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {outcome && sel.mode === "MAP" && (
          <div className="mt-3 space-y-2">
            {outcome.errors.map((error, index) => (
              <p
                key={`err-${index}`}
                className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-xs text-danger-11"
              >
                {error}
              </p>
            ))}
            {outcome.notes.map((note, index) => (
              <p
                key={`note-${index}`}
                className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11"
              >
                {note}
              </p>
            ))}
            {outcome.fieldDiffs.some((diff) => diff.willChange) ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 pr-3">Field</th>
                      <th className="py-1 pr-3">Current</th>
                      <th className="py-1">Application</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.fieldDiffs
                      .filter((diff) => diff.willChange)
                      .map((diff) => (
                        <tr key={diff.field} className="bg-warning-3/60">
                          <td className="py-1 pr-3 font-medium text-muted-foreground">
                            {diff.label}
                          </td>
                          <td className="py-1 pr-3 text-muted-foreground line-through">
                            {diff.current ?? "—"}
                          </td>
                          <td className="py-1 font-medium text-foreground">
                            {diff.incoming ?? "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No field changes — the application matches this member.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Approve: map to existing members
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          For each person choose Create new (default) or Map to an existing
          member. Mapping overwrites the member&apos;s details from the
          application — preview the changes before approving.
        </p>
      </div>

      <div className="space-y-3">
        {renderPersonRow(
          { kind: "applicant" },
          `${application.applicantFirstName} ${application.applicantLastName} (applicant)`,
          applicantSel,
          updateApplicantMode,
          chooseApplicantMember,
        )}
        {application.familyMembers.map((familyMember, index) =>
          renderPersonRow(
            { kind: "family", index },
            `${familyMember.firstName} ${familyMember.lastName} (dependent)`,
            familySel[index] ?? { mode: "CREATE", member: null },
            (mode) => updateFamilyMode(index, mode),
            (member) => chooseFamilyMember(index, member),
          ),
        )}
      </div>

      {hasMappings && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={previewing || !allMapTargetsChosen}
            onClick={runPreview}
          >
            {previewing ? "Previewing..." : "Preview mapping"}
          </Button>
          {preview && previewIsFresh && previewErrors.length === 0 && (
            <span className="text-sm text-success-11">
              Preview ready — no blocking issues.
            </span>
          )}
          {preview && !previewIsFresh && (
            <span className="text-sm text-warning-11">
              Selections changed — preview again before approving.
            </span>
          )}
        </div>
      )}

      {preview && preview.blockingErrors.length > 0 && (
        <div className="space-y-1">
          {preview.blockingErrors.map((error, index) => (
            <p
              key={index}
              className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
            >
              {error}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3 rounded-md border border-warning-6 bg-warning-3 p-4 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-warning-11">
            Joining fee invoice
          </p>
          <p className="mt-1 text-warning-11">
            Choose whether to raise the joining fee invoice when this application
            is approved.
            {applicantSel.mode === "MAP" && (
              <span className="font-medium">
                {" "}
                Defaults to skip for a mapped applicant.
              </span>
            )}
          </p>
        </div>
        <select
          className="w-full rounded-md border border-warning-6 bg-card px-3 py-2 text-sm text-foreground"
          value={effectiveFee.action}
          onChange={(event) => {
            setFeeTouched(true);
            setFee({ ...effectiveFee, action: event.target.value as "CREATE" | "SKIP" });
          }}
        >
          <option value="CREATE">Raise joining fee invoice</option>
          <option value="SKIP">Do not raise invoice</option>
        </select>
        {effectiveFee.action === "CREATE" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Amount override ($)</span>
              <input
                className="w-full rounded-md border border-warning-6 px-3 py-2 text-sm"
                {...MONEY_INPUT_PROPS}
                placeholder="Use configured amount"
                value={effectiveFee.amount}
                onChange={(event) => {
                  setFeeTouched(true);
                  setFee({ ...effectiveFee, amount: event.target.value });
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Narration override</span>
              <input
                className="w-full rounded-md border border-warning-6 px-3 py-2 text-sm"
                placeholder="Use default narration"
                value={effectiveFee.narration}
                onChange={(event) => {
                  setFeeTouched(true);
                  setFee({ ...effectiveFee, narration: event.target.value });
                }}
              />
            </label>
            <div className="md:col-span-2">
              <JoiningFeePreviewHint state={joiningFeePreview} />
            </div>
          </div>
        ) : (
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              Reason for not raising invoice
            </span>
            <textarea
              className="min-h-24 w-full rounded-md border border-warning-6 px-3 py-2 text-sm"
              value={effectiveFee.reason}
              onChange={(event) => {
                setFeeTouched(true);
                setFee({ ...effectiveFee, reason: event.target.value });
              }}
            />
          </label>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <ViewOnlyActionButton
          canEdit={canEdit}
          type="button"
          disabled={approveDisabled}
          onClick={handleApprove}
        >
          {submitting ? "Working..." : "Approve"}
        </ViewOnlyActionButton>
        <ViewOnlyActionButton
          canEdit={canEdit}
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={handleReject}
        >
          Reject
        </ViewOnlyActionButton>
      </div>
    </div>
  );
}
