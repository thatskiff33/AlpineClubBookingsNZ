/**
 * The registry CONTRACT, enforced over every entry that will ever be added. These
 * assertions are the mechanical half of the "adding a tool" checklist in
 * `registry.ts`: any shipped or future tool pack that carries an unbounded query, a
 * multi-statement string, a missing permission requirement, or a schema that
 * silently ignores unknown arguments fails here rather than in production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";
import { canonicalStringify, sha256Hex } from "@/lib/diagnostics/knowledge/hash";

import {
  consentedRecordForToolCall,
  declaresConsentRecord,
} from "../consent";
import { readSqlPlaceholderNumbers } from "../database";
import { READ_ONLY_SEAM_EXEMPTION_IDS } from "../read-only-seam-exemptions";
import {
  defineDiagnosticsTool,
  DIAGNOSTICS_TOOL_EVIDENCE_SOURCES,
  FORBIDDEN_TOOL_SQL_PATTERNS,
  isValidDiagnosticsToolId,
  type DiagnosticsSelectOnlyToolEntry,
  type DiagnosticsToolEntry,
} from "../define";
import {
  DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID,
  DIAGNOSTICS_DEPLOYMENT_TOOL_ID,
  DIAGNOSTICS_READINESS_TOOL_ID,
  DIAGNOSTICS_USAGE_HEALTH_TOOL_ID,
} from "../packs/support-system";
import {
  DIAGNOSTICS_FINANCE_AMOUNT_SEARCH_TOOL_ID,
  DIAGNOSTICS_FINANCE_PAYMENT_SEARCH_TOOL_ID,
} from "../packs/finance-search";
import {
  DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID,
  DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID,
  DIAGNOSTICS_PAYMENT_ATTEMPT_LEDGER_TOOL_ID,
  DIAGNOSTICS_PAYMENT_REFUND_STATE_TOOL_ID,
  DIAGNOSTICS_PAYMENT_SUMMARY_TOOL_ID,
  DIAGNOSTICS_XERO_CONTACT_LINKAGE_TOOL_ID,
  DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID,
} from "../packs/finance-records";
import { DIAGNOSTICS_BOOKING_FINANCE_STATE_TOOL_ID } from "../packs/finance-state";
import {
  DIAGNOSTICS_BOOKING_SEARCH_TOOL_ID,
  DIAGNOSTICS_MEMBER_SEARCH_TOOL_ID,
} from "../packs/booking-search";
import {
  DIAGNOSTICS_BOOKING_AUDIT_HISTORY_TOOL_ID,
  DIAGNOSTICS_BOOKING_BED_ALLOCATION_TOOL_ID,
  DIAGNOSTICS_BOOKING_EXCEPTION_REQUEST_TOOL_ID,
  DIAGNOSTICS_BOOKING_LINKED_STATE_TOOL_ID,
  DIAGNOSTICS_BOOKING_PARTY_TOOL_ID,
  DIAGNOSTICS_BOOKING_SUMMARY_TOOL_ID,
} from "../packs/booking-records";
import {
  DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID,
  DIAGNOSTICS_MEMBER_BOOKING_SUMMARY_TOOL_ID,
  DIAGNOSTICS_MEMBER_FAMILY_STATE_TOOL_ID,
  DIAGNOSTICS_MEMBER_SUBSCRIPTION_STATE_TOOL_ID,
  DIAGNOSTICS_MEMBER_SUMMARY_TOOL_ID,
} from "../packs/membership-records";
import {
  DIAGNOSTICS_BOOKING_BLOCK_STATE_TOOL_ID,
  DIAGNOSTICS_BOOKING_CAPACITY_TOOL_ID,
  DIAGNOSTICS_MEMBER_ELIGIBILITY_TOOL_ID,
} from "../packs/booking-state";
import {
  BOOKING_BLOCKER_CODES,
  MEMBER_ELIGIBILITY_CODES,
} from "../packs/booking-evidence";
import { PERSON_NAME_MAX_CHARS } from "../packs/booking-shared";
import {
  DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS,
} from "../packs/support-correlation";
import { renderToolResultEvidenceBlock } from "../render";
import {
  DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
  DIAGNOSTICS_TOOLS,
  findDiagnosticsTool,
} from "../registry";
import {
  DIAGNOSTICS_CONSENT_RECORD_KINDS,
  DIAGNOSTICS_TOOL_BOUNDS,
} from "../types";

/**
 * Only the `select_only_sql` entries carry SQL, so the statement-shaped contracts
 * below iterate this list rather than the whole registry.
 *
 * What stops that narrowing from silently skipping an entry that should have been
 * checked is the evidence-source contract test, which runs over the WHOLE registry
 * and asserts that anything not declaring `select_only_sql` exposes no `sql`, no
 * `bind` and no `readEvidence` handle at all. The permission, argument, projection
 * and bound contracts still run over every entry regardless of source; the
 * server-owned entries' own evidence sources are covered in
 * `packs/__tests__/support-system.test.ts`.
 */
const SQL_TOOLS: readonly DiagnosticsSelectOnlyToolEntry[] = DIAGNOSTICS_TOOLS.filter(
  (tool): tool is DiagnosticsSelectOnlyToolEntry =>
    tool.source === "select_only_sql",
);

const AREA_KEYS = new Set(ADMIN_PERMISSION_AREAS.map((area) => area.key));

/**
 * A REALISTIC WIDEST raw row per entry, so the bound contracts below can measure what
 * a deployment actually produces instead of trusting an estimate.
 *
 * Same census discipline as `EXAMPLE_ARGS`: a new entry with no row here fails
 * loudly. The reason it exists is a defect this caught (#2375):
 * `background_job_health` declared `byteLimit: 8_192`, and twenty rows of its own
 * projected shape on an ordinary deployment — every job having simply run once —
 * serialised to 8 272 bytes, so gate 9 refused every full result with
 * `result_too_large` and told the operator to narrow a question that takes no
 * arguments. Nothing caught it because the registry contract only checked
 * `byteLimit <= maxResultBytes`, never that an entry's own limit was ACHIEVABLE at its
 * own `rowLimit`.
 *
 * HOW WIDE EACH FIELD IS SET, because the line matters and getting it wrong is what
 * let a too-tight ceiling survive a mutation of this very test. Setting *every* string
 * to `fieldValueMaxChars` (200) is not the answer: the absolute worst case for a
 * twelve-field row at 200 characters each exceeds the substrate's hard 32 768 by
 * construction, and it would also fail entries whose values are structurally short —
 * `substrate_probe.statementTimeout` is PostgreSQL's own rendering of a GUC, and a
 * 200-character one does not exist. So the rule is per field:
 *
 *  - A field whose width is **open-ended in this system** is set to the projection's
 *    own 200-character cap, because a future feature can make it that wide without
 *    anyone revisiting the ceiling: `action_code` (audit action codes already run to 60
 *    characters and nothing bounds them) and `job_name` (any pull request may register
 *    a longer one). These are the fields that turn a comfortable ceiling into a refused
 *    result later, so they are measured at the cap now.
 *  - A field whose width is **structurally fixed** is set to the widest real value: an
 *    ISO-8601 instant, a cuid, a closed enum, a 40-character commit SHA, the longest
 *    entity-type name in the schema, a request id at the 128-character cap the
 *    correlation projection now enforces.
 *
 * `result_too_large` remains the fail-closed backstop for anything wilder than that.
 */
/** A cuid, which is what every record identifier in this schema is. */
const WIDEST_RECORD_ID = "clz0000000abcdefghijklmno";
/** An ISO-8601 instant as the projections render one. */
const WIDEST_INSTANT = "2026-08-08T09:00:00.000Z";
/**
 * The widest a PROJECTED person name or family-group name can be, taken from the
 * projection's own cap rather than written as a number: `personNameOrNull` clips
 * at `PERSON_NAME_MAX_CHARS` and marks the clip, so a longer stored name cannot
 * reach a row and measuring one here would inflate the ceiling with bytes no
 * deployment can produce. Widening the cap re-measures every entry that carries a
 * name.
 */
const WIDEST_PROJECTED_NAME = "N".repeat(PERSON_NAME_MAX_CHARS);
/** Likewise for a room or bed label, which `lodgeLabelOrNull` clips at 24. */
const WIDEST_PROJECTED_LODGE_LABEL = "L".repeat(24);
/**
 * Open-ended, so measured at the substrate's own field cap: an audit action code
 * in this repository already runs to 60 characters and nothing bounds a new one,
 * and an email address is member-typed text that RFC 5321 allows to reach 254 —
 * gate 8 caps the projected value at `fieldValueMaxChars`, so that is the widest
 * value either field can actually put in a row.
 */
const WIDEST_ACTION_CODE = "a".repeat(DIAGNOSTICS_TOOL_BOUNDS.fieldValueMaxChars);
const WIDEST_PROJECTED_EMAIL = `${"e".repeat(
  DIAGNOSTICS_TOOL_BOUNDS.fieldValueMaxChars - "@example.org".length,
)}@example.org`;

const EXAMPLE_RAW_ROWS: Record<string, Record<string, unknown>> = {
  [DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID]: {
    probe_ok: true,
    transaction_read_only: "on",
    statement_timeout: "5s",
    statement_timeout_ms: 5_000,
  },
  [DIAGNOSTICS_READINESS_TOOL_ID]: {
    readiness_state: "not_ready",
    module_enabled: true,
    credential_state: "needs_reentry",
    monthly_budget_cents: 50_000,
    database_role_state: "over_privileged",
    blocker_codes:
      "module_disabled,credential_needs_reentry,database_not_configured,database_role_unsafe,budget_exhausted",
    blocker_count: 5,
  },
  [DIAGNOSTICS_DEPLOYMENT_TOOL_ID]: {
    release_id: "v0.13.0-rc.4+build.20260803",
    release_id_source: "release-id",
    app_version: "0.13.0",
    node_version: "v22.14.0",
    runtime_role: "web-green",
    uptime_seconds: 987_654,
    knowledge_bundle_state: "verified",
    knowledge_bundle_commit_sha: "a".repeat(40),
    knowledge_bundle_commit_verified: true,
    knowledge_bundle_observed_at_utc: "2026-08-03T03:04:05.678Z",
    knowledge_bundle_generator: "scripts/build-knowledge-bundle.ts",
    knowledge_bundle_entry_count: 4_321,
  },
  [DIAGNOSTICS_USAGE_HEALTH_TOOL_ID]: {
    month: "2026-08",
    monthly_budget_cents: 50_000,
    settled_cents: 12_345,
    active_reserved_cents: 84,
    remaining_cents: 37_571,
    budget_status: "warning_threshold_reached",
    request_count: 1_234,
    roundtrip_count: 5_678,
    failed_count: 90,
    stale_reservation_count: 3,
    latest_success_at_utc: "2026-08-03T09:00:00.000Z",
    latest_failure_at_utc: "2026-08-03T08:59:59.999Z",
    latest_failure_code: "overloaded_error",
    worst_case_roundtrip_cents: 42,
    max_tool_rounds: 8,
  },
  [DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID]: {
    // Open-ended, so measured at the projection's 200-character cap. The longest name
    // this release registers is `placeholder-guest-name-reminders` at 32 characters,
    // but nothing stops a pull request registering a much longer one, and that is
    // precisely how a ceiling that fits today stops fitting — the old 8 192-byte
    // ceiling had 89 bytes of margin at the real names. A job with both a success and
    // an older failure also keeps every timestamp field populated, which is the steady
    // state of a mature deployment and the case that ceiling refused outright.
    job_name: "j".repeat(200),
    status: "stale",
    severity: "warning",
    enabled: true,
    schedule: "*/15 * * * *",
    stale_after_minutes: 1_440,
    latest_run_at_utc: "2026-08-03T03:04:05.678Z",
    latest_run_status: "SUCCESS",
    latest_success_at_utc: "2026-08-03T03:04:05.678Z",
    latest_failure_at_utc: "2026-05-01T03:04:05.678Z",
    cron_scheduling_enabled: true,
    registered_job_count: 34,
  },
  // AID-6C (#2377). The open-ended-width rule applies to the internet-banking
  // reference, which is whatever a payer typed into their own bank: the pack's
  // projection caps it at 64 characters, so that is where it is measured. Every
  // other field here is structurally fixed — a cuid, an ISO instant, a closed
  // enum, a provider identifier — and is set to the widest REAL value.
  ...Object.fromEntries(
    [
      DIAGNOSTICS_FINANCE_PAYMENT_SEARCH_TOOL_ID,
      DIAGNOSTICS_FINANCE_AMOUNT_SEARCH_TOOL_ID,
    ].map((id) => [
      id,
      {
        payment_ref: "clz0000000abcdefghijklmno",
        booking_id: "clz0000000abcdefghijklmno",
        booking_reference: "CLZ00000",
        payment_status: "PARTIALLY_REFUNDED",
        payment_source: "INTERNET_BANKING",
        amount_cents: 1_234_567,
        refunded_amount_cents: 1_234_567,
        credit_applied_cents: 1_234_567,
        additional_amount_cents: 1_234_567,
        additional_payment_status: "SUCCEEDED",
        has_stripe_intent: true,
        has_xero_invoice: true,
        xero_invoice_number: "INV-0001234",
        bank_reference: "b".repeat(64),
        manually_marked_paid: true,
        created_at_utc: "2026-08-08T09:00:00Z",
        updated_at_utc: "2026-08-08T09:00:00Z",
      },
    ]),
  ),
  [DIAGNOSTICS_PAYMENT_SUMMARY_TOOL_ID]: {
    payment_ref: "clz0000000abcdefghijklmno",
    booking_id: "clz0000000abcdefghijklmno",
    booking_reference: "CLZ00000",
    payment_status: "PARTIALLY_REFUNDED",
    payment_source: "INTERNET_BANKING",
    amount_cents: 1_234_567,
    refunded_amount_cents: 1_234_567,
    change_fee_cents: 1_234_567,
    additional_amount_cents: 1_234_567,
    credit_applied_cents: 1_234_567,
    additional_payment_status: "SUCCEEDED",
    stripe_payment_intent_id: "pi_3QabcdefghijklmnopqrstuV",
    additional_payment_intent_id: "pi_3QabcdefghijklmnopqrstuV",
    xero_invoice_id: "00000000-0000-4000-8000-000000000000",
    xero_invoice_number: "INV-0001234",
    xero_refund_credit_note_id: "00000000-0000-4000-8000-000000000000",
    bank_reference: "b".repeat(64),
    internet_banking_hold_slots: true,
    internet_banking_hold_until_utc: "2026-08-08T09:00:00Z",
    internet_banking_hold_released_at_utc: "2026-08-08T09:00:00Z",
    manually_marked_paid_at_utc: "2026-08-08T09:00:00Z",
    created_at_utc: "2026-08-08T09:00:00Z",
    updated_at_utc: "2026-08-08T09:00:00Z",
  },
  [DIAGNOSTICS_PAYMENT_ATTEMPT_LEDGER_TOOL_ID]: {
    entry_kind: "recovery_operation",
    entry_ref: "clz0000000abcdefghijklmno",
    kind_code: "CREATE_ADDITIONAL_PAYMENT_INTENT",
    source_code: "INTERNET_BANKING",
    status_code: "PARTIALLY_REFUNDED",
    amount_cents: 1_234_567,
    refunded_amount_cents: 1_234_567,
    provider_ref: "pi_3QabcdefghijklmnopqrstuV",
    xero_invoice_number: "INV-0001234",
    bank_reference: "b".repeat(64),
    scenario_code: "capacity_claim_failed_refund",
    attempt_count: 5,
    settled_at_utc: "2026-08-08T09:00:00Z",
    occurred_at_utc: "2026-08-08T09:00:00Z",
    updated_at_utc: "2026-08-08T09:00:00Z",
  },
  [DIAGNOSTICS_PAYMENT_REFUND_STATE_TOOL_ID]: {
    entry_kind: "manual_refund_task",
    entry_ref: "clz0000000abcdefghijklmno",
    status_code: "PARTIALLY_REFUNDED",
    amount_cents: 1_234_567,
    secondary_amount_cents: 1_234_567,
    currency_code: "nzd",
    provider_ref: "re_3QabcdefghijklmnopqrstuV",
    secondary_provider_ref: "ch_3QabcdefghijklmnopqrstuV",
    has_xero_credit_note: true,
    scenario_code: "capacity_claim_failed_refund",
    attempt_count: 5,
    settled_at_utc: "2026-08-08T09:00:00Z",
    occurred_at_utc: "2026-08-08T09:00:00Z",
  },
  [DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID]: {
    entry_kind: "xero_inbound_event",
    entry_ref: "clz0000000abcdefghijklmno",
    provider_code: "stripe",
    // Open-ended in practice: a provider names its own event types, and Stripe's
    // longest today is around 40 characters. Measured at the stable-code cap.
    event_type: "e".repeat(48),
    event_ref: "evt_3QabcdefghijklmnopqrstuV",
    status_code: "PROCESSING",
    category_code: "INVOICE",
    duration_ms: 123_456,
    started_at_utc: "2026-08-08T09:00:00Z",
    processed_at_utc: "2026-08-08T09:00:00Z",
    occurred_at_utc: "2026-08-08T09:00:00Z",
  },
  ...Object.fromEntries(
    [
      DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID,
      DIAGNOSTICS_XERO_CONTACT_LINKAGE_TOOL_ID,
    ].map((id) => [
      id,
      {
        entry_kind: "sync_operation",
        entry_ref: "clz0000000abcdefghijklmno",
        xero_object_type: "CreditNoteAllocation",
        xero_object_id: "00000000-0000-4000-8000-000000000000",
        xero_object_number: "INV-0001234",
        role_code: "MEMBERSHIP_CANCELLATION_CREDIT",
        is_active: true,
        status_code: "WAITING_PAYMENT",
        operation_type_code: "BOOKING_INVOICE_EDIT_SETTLEMENT",
        direction_code: "OUTBOUND",
        attempt_count: 12,
        is_replayable: true,
        // Open-ended: Xero names its own error codes. Measured at the cap.
        last_error_code: "e".repeat(48),
        manually_resolved: true,
        started_at_utc: "2026-08-08T09:00:00Z",
        completed_at_utc: "2026-08-08T09:00:00Z",
        occurred_at_utc: "2026-08-08T09:00:00Z",
        updated_at_utc: "2026-08-08T09:00:00Z",
      },
    ]),
  ),
  [DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID]: {
    event_ref: "clz0000000abcdefghijklmno",
    // Open-ended, exactly as for the AID-6A correlation entries: real action codes
    // already reach 60 characters and nothing bounds a new one.
    action_code: "a".repeat(48),
    category_code: "payment",
    severity_code: "important",
    outcome_code: "success",
    entity_type: "ManualRefundTask",
    occurred_at_utc: "2026-08-08T09:00:00Z",
  },
  [DIAGNOSTICS_BOOKING_FINANCE_STATE_TOOL_ID]: {
    booking_id: "clz0000000abcdefghijklmno",
    booking_reference: "CLZ00000",
    booking_status: "WAITLIST_OFFERED",
    payment_ref: "clz0000000abcdefghijklmno",
    payment_status: "PARTIALLY_REFUNDED",
    payment_source: "INTERNET_BANKING",
    payment_display_label: "Partial Credit + Card Refund",
    settlement_kind: "restoredCredit",
    xero_state: "operationPending",
    amount_due_cents: 1_234_567,
    credit_applied_cents: 1_234_567,
    amount_paid_cents: 1_234_567,
    refunded_amount_cents: 1_234_567,
    outstanding_cents: -1_234_567,
    uncollected_additional_cents: 1_234_567,
    remaining_refundable_cents: 1_234_567,
    ledger_variance_cents: -1_234_567,
    credit_ledger_variance_cents: -1_234_567,
    member_credit_balance_cents: 1_234_567,
    // The widest possible list: every declared blocker code at once.
    blocker_codes:
      "payment_record_missing,refund_execution_exhausted,refund_execution_pending,manual_refund_open,refund_appeal_pending,xero_operation_failed,xero_operation_partial,xero_operation_pending,xero_invoice_missing,additional_payment_outstanding,payment_failed,payment_processing,payment_pending,ledger_variance,credit_ledger_variance",
    blocker_count: 15,
    manually_marked_paid: true,
    booking_lifecycle_terminal: true,
    observed_at_utc: "2026-08-08T09:00:00.000Z",
  },
  ...Object.fromEntries(
    DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS.map((tool) => [
      tool.id,
      {
        event_ref: "clz0000000abcdefghijklmno",
        // Open-ended, so measured at the projection's 200-character cap. Real action
        // codes in this repository already reach 60 characters
        // (`booking_request.member_whole_lodge_approve_idempotent_replay`) and nothing
        // bounds a new one, so a ceiling that only fits today's codes is a ceiling that
        // refuses a full result the first time someone writes a longer one.
        action_code: "a".repeat(200),
        category: "payment",
        severity: "important",
        outcome: "success",
        entity_type: "SeasonalMembershipAssignment",
        // The 128-character cap the projection now enforces — the widest a member can
        // plant through the `x-request-id` header.
        request_id: `r${"0".repeat(127)}`,
        occurred_at_utc: "2026-08-03T09:00:00Z",
      },
    ]),
  ),

  // -------------------------------------------------------------------------
  // AID-6B (#2376), the booking/membership/induction/bed-allocation pack.
  //
  // Same per-field rule as the entries above, and it lands differently here
  // because most of AID-6B's open-ended text is capped BY THE PROJECTION rather
  // than by the substrate. A person's name cannot reach the substrate's
  // 200-character field cap, because `personNameOrNull` hard-caps it at
  // `PERSON_NAME_MAX_CHARS` (60) and marks the clip; a room or bed label is
  // capped at 24 the same way. So the widest raw value worth measuring for those
  // fields is the projection's own cap, and it is written as the constant rather
  // than as a number so a future widening of the cap re-measures these ceilings
  // instead of silently passing under them.
  //
  // The fields still measured at the substrate's 200-character cap are the ones
  // nothing in this pack bounds: an audit `action_code` (already 60 characters in
  // this repository and unbounded for a new one) and an email address (a member
  // types it; RFC 5321 allows 254 and gate 8 caps the projected value at 200).
  //
  // The code LISTS are set to every declared code at once — the genuinely widest
  // value each can hold — for the same reason `booking_finance_state` is above:
  // a row carrying one blocker measures nothing about the ceiling.
  [DIAGNOSTICS_BOOKING_SEARCH_TOOL_ID]: {
    booking_ref: WIDEST_RECORD_ID,
    booking_reference: "CLZ00000",
    owner_member_ref: WIDEST_RECORD_ID,
    lodge_ref: WIDEST_RECORD_ID,
    lodge_name: WIDEST_PROJECTED_NAME,
    booking_status: "WAITLIST_OFFERED",
    check_in: "2026-08-08",
    check_out: "2026-09-08",
    guest_count: 30,
    final_price_cents: 1_234_567,
    has_non_members: true,
    is_linked_child: true,
    requires_admin_review: true,
    admin_review_status: "NOT_REQUIRED",
    hosting_review_status: "NOT_REQUIRED",
    waitlist_position: 999,
    // The alias the STATEMENT emits. It was `whole_lodge_hold` until the
    // stored-vs-effective rename, and the fixture kept the old name for a release:
    // the projection then read an absent key and this row silently stopped being
    // the widest one it is declared to be. The parity assertion below is what
    // makes that visible now.
    whole_lodge_hold_flag_stored: true,
    admin_capacity_hold: true,
    capacity_overridden: true,
    deleted_at_utc: WIDEST_INSTANT,
    created_at_utc: WIDEST_INSTANT,
    updated_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_MEMBER_SEARCH_TOOL_ID]: {
    member_ref: WIDEST_RECORD_ID,
    first_name: WIDEST_PROJECTED_NAME,
    last_name: WIDEST_PROJECTED_NAME,
    age_tier: "INFANT",
    is_active: true,
    can_login: true,
    is_cancelled: true,
    is_archived: true,
    lifecycle_deleted: true,
    has_email: true,
    has_phone: true,
    has_xero_contact: true,
    has_parent_link: true,
    requires_induction: true,
    joined_date: "2026-08-08",
    created_at_utc: WIDEST_INSTANT,
    updated_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_BOOKING_SUMMARY_TOOL_ID]: {
    booking_ref: WIDEST_RECORD_ID,
    booking_reference: "CLZ00000",
    owner_member_ref: WIDEST_RECORD_ID,
    lodge_ref: WIDEST_RECORD_ID,
    booking_status: "WAITLIST_OFFERED",
    check_in: "2026-08-08",
    check_out: "2026-09-08",
    night_count: 31,
    guest_count: 30,
    total_price_cents: 1_234_567,
    discount_cents: 1_234_567,
    promo_adjustment_cents: -1_234_567,
    final_price_cents: 1_234_567,
    credit_election_cents: 1_234_567,
    has_non_members: true,
    non_member_hold_until_utc: WIDEST_INSTANT,
    parent_booking_ref: WIDEST_RECORD_ID,
    draft_expires_at_utc: WIDEST_INSTANT,
    admin_review_status: "NOT_REQUIRED",
    hosting_review_status: "NOT_REQUIRED",
    whole_lodge_hold_flag_stored: true,
    deleted_at_utc: WIDEST_INSTANT,
    created_at_utc: WIDEST_INSTANT,
    updated_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_BOOKING_LINKED_STATE_TOOL_ID]: {
    relation_type: "child",
    booking_ref: WIDEST_RECORD_ID,
    booking_reference: "CLZ00000",
    booking_status: "WAITLIST_OFFERED",
    check_in: "2026-08-08",
    check_out: "2026-09-08",
    whole_lodge_hold_flag_stored: true,
    is_deleted: true,
  },
  [DIAGNOSTICS_BOOKING_PARTY_TOOL_ID]: {
    guest_ref: WIDEST_RECORD_ID,
    first_name: WIDEST_PROJECTED_NAME,
    last_name: WIDEST_PROJECTED_NAME,
    age_tier: "INFANT",
    is_member: true,
    guest_member_ref: WIDEST_RECORD_ID,
    stay_start: "2026-08-08",
    stay_end: "2026-09-08",
    night_count: 31,
    nights_are_contiguous: true,
    first_night: "2026-08-08",
    last_night: "2026-09-07",
    price_cents: 1_234_567,
    operationally_present: true,
    /**
     * THE FIVE DISCRIMINATOR COLUMNS THE STATEMENT ACTUALLY EMITS.
     *
     * This used to be one `consent_sub_state` key, which the statement has never
     * selected and the projection has never read: `consentSubState` is DERIVED from
     * these five by `consentSubStateOf`. The widest sub-state came out anyway, but
     * only because an ABSENT `consent_status` falls through to
     * `unrecognised_consent_shape` — so the widest row was being measured by
     * accident, off a key that was never real. The key-parity assertion below is what
     * made that visible.
     *
     * The values are the notify-only auto-confirmed shape (D-3 opt-down: CONFIRMED
     * with a null requestedAt AND a null respondedBy), whose code
     * `notify_only_auto_confirmed` is 26 characters — the widest any REACHABLE
     * classification produces, and reachable is the point: measuring against a code
     * only a corrupt enum value could produce would be measuring a row PostgreSQL
     * cannot store.
     */
    consent_status: "CONFIRMED",
    consent_requested_at: null,
    consent_responded_at: null,
    consent_responded_by_member_ref: null,
    consent_expires_at: null,
  },
  [DIAGNOSTICS_BOOKING_BED_ALLOCATION_TOOL_ID]: {
    stay_date: "2026-08-08",
    guest_ref: WIDEST_RECORD_ID,
    room_name: WIDEST_PROJECTED_LODGE_LABEL,
    bed_name: WIDEST_PROJECTED_LODGE_LABEL,
    bed_type: "DOUBLE",
    bed_type_matches_bed: true,
    is_second_occupant: true,
    // The LIVE bed type off the `LodgeBed` row, which the classifier reads and this
    // fixture did not supply — so `doubleBedSharingState` was measured at
    // `live_bed_missing` (17 characters) while the widest state this row can produce
    // is `ineligible_partner_link_pending` (31). Thirty allocation rows on a 24,576-byte
    // ceiling is where that difference is spent.
    live_bed_type: "DOUBLE",
    other_occupant_count: 1,
    member_a_ref: WIDEST_RECORD_ID,
    member_b_ref: "clz1111111abcdefghijklmno",
    member_a_exists: true,
    member_b_exists: true,
    member_a_active: true,
    member_b_active: true,
    member_a_age_tier: "ADULT",
    member_b_age_tier: "ADULT",
    partner_link_status: "UNRECOGNISED",
  },
  [DIAGNOSTICS_BOOKING_EXCEPTION_REQUEST_TOOL_ID]: {
    request_ref: WIDEST_RECORD_ID,
    request_kind: "POLICY_EXCEPTION",
    request_status: "SUPERSEDED",
    requested_by_member_ref: WIDEST_RECORD_ID,
    aggregate_capacity_mode: "NO_HOLD",
    attempt_count: 99,
    conflict_count: 99,
    last_conflict_at_utc: WIDEST_INSTANT,
    held_night_count: 31,
    hold_expires_at_utc: WIDEST_INSTANT,
    reviewed_at_utc: WIDEST_INSTANT,
    cancelled_at_utc: WIDEST_INSTANT,
    superseded_by_request_ref: WIDEST_RECORD_ID,
    linked_modification_ref: WIDEST_RECORD_ID,
    created_at_utc: WIDEST_INSTANT,
    updated_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_BOOKING_AUDIT_HISTORY_TOOL_ID]: {
    event_ref: WIDEST_RECORD_ID,
    action_code: WIDEST_ACTION_CODE,
    category_code: "booking_request",
    severity_code: "important",
    outcome_code: "success",
    entity_type: "Booking",
    occurred_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_MEMBER_SUMMARY_TOOL_ID]: {
    member_ref: WIDEST_RECORD_ID,
    first_name: WIDEST_PROJECTED_NAME,
    last_name: WIDEST_PROJECTED_NAME,
    email_address: WIDEST_PROJECTED_EMAIL,
    has_phone: true,
    age_tier: "INFANT",
    is_active: true,
    can_login: true,
    cancelled_at_utc: WIDEST_INSTANT,
    archived_at_utc: WIDEST_INSTANT,
    lifecycle_deleted: true,
    joined_date: "2026-08-08",
    life_member_date: "2026-08-08",
    requires_induction: true,
    hut_leader_eligible: true,
    has_xero_contact: true,
    parent_member_ref: WIDEST_RECORD_ID,
    secondary_parent_ref: WIDEST_RECORD_ID,
    legacy_family_group_ref: WIDEST_RECORD_ID,
    billing_family_group_ref: WIDEST_RECORD_ID,
    dependent_count: 99,
    created_at_utc: WIDEST_INSTANT,
    updated_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_MEMBER_SUBSCRIPTION_STATE_TOOL_ID]: {
    subscription_ref: WIDEST_RECORD_ID,
    season_year: 2026,
    subscription_status: "NOT_INVOICED",
    // Xero names its own invoice numbers and a club can configure the prefix, so
    // this is open-ended in the same sense an action code is.
    xero_invoice_number: "I".repeat(40),
    has_xero_invoice: true,
    paid_at_utc: WIDEST_INSTANT,
    manually_marked_paid_at_utc: WIDEST_INSTANT,
    void_generation: 99,
    created_at_utc: WIDEST_INSTANT,
    updated_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_MEMBER_FAMILY_STATE_TOOL_ID]: {
    relation_ref: WIDEST_RECORD_ID,
    relation_kind: "FAMILY_GROUP_CO_MEMBER",
    related_member_ref: WIDEST_RECORD_ID,
    related_first_name: WIDEST_PROJECTED_NAME,
    related_last_name: WIDEST_PROJECTED_NAME,
    related_age_tier: "INFANT",
    related_is_active: true,
    related_is_cancelled: true,
    related_is_archived: true,
    family_group_ref: WIDEST_RECORD_ID,
    family_group_name: WIDEST_PROJECTED_NAME,
    joined_at_utc: WIDEST_INSTANT,
    is_secondary_parent: true,
  },
  [DIAGNOSTICS_MEMBER_BOOKING_SUMMARY_TOOL_ID]: {
    booking_ref: WIDEST_RECORD_ID,
    booking_reference: "CLZ00000",
    involvement: "owner",
    lodge_ref: WIDEST_RECORD_ID,
    lodge_name: WIDEST_PROJECTED_NAME,
    booking_status: "WAITLIST_OFFERED",
    check_in: "2026-08-08",
    check_out: "2026-09-08",
    guest_count: 30,
    final_price_cents: 1_234_567,
    // `false` and not `true`: the widest serialisation of the three values this
    // three-valued field can take (`false` is 5 characters, `true` and `null` are 4).
    member_operationally_present: false,
    deleted_at_utc: WIDEST_INSTANT,
    created_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID]: {
    event_ref: WIDEST_RECORD_ID,
    action_code: WIDEST_ACTION_CODE,
    category_code: "communication",
    severity_code: "important",
    outcome_code: "success",
    // The longest entity type this entry's own subject map can name.
    entity_type: "MembershipCancellationRequest",
    occurred_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_BOOKING_BLOCK_STATE_TOOL_ID]: {
    booking_id: WIDEST_RECORD_ID,
    booking_reference: "CLZ00000",
    owner_member_ref: WIDEST_RECORD_ID,
    booking_status: "WAITLIST_OFFERED",
    booking_lifecycle_state: "terminal",
    check_in: "2026-08-08",
    check_out: "2026-09-08",
    admin_review_pending: true,
    hosting_review_pending: true,
    // Every review reason at once, as `bookingReviewReasonCodes` joins them.
    review_reason_codes: "ADULT_SUPERVISION,ADULT_MEMBER_HOSTING_REQUIRED",
    // Every persisted policy violation the non-hosting and canonical hosting
    // evaluators can raise, in the sorted order this source joins them in.
    policy_violation_codes:
      "ADULT_MEMBER_HOSTING_REQUIRED,MINIMUM_STAY,PAID_UP_ADULT_MEMBER_REQUIRED",
    policy_capacity_mode: "NO_HOLD",
    member_night_conflict_count: 99,
    shortfall_night_count: 31,
    whole_lodge_held_night_count: 31,
    tightest_spare_beds: -99,
    open_exception_request_count: 99,
    exception_held_night_count: 31,
    exception_hold_expires_at_utc: WIDEST_INSTANT,
    member_can_modify: true,
    edit_window_mode: "LOCKED_PERIOD",
    // Every declared blocker at once — DERIVED, so a new code widens this row
    // instead of leaving the ceiling measured against a stale list.
    blocker_codes: BOOKING_BLOCKER_CODES.join(","),
    blocker_count: BOOKING_BLOCKER_CODES.length,
    observed_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_BOOKING_CAPACITY_TOOL_ID]: {
    booking_id: WIDEST_RECORD_ID,
    booking_reference: "CLZ00000",
    lodge_ref: WIDEST_RECORD_ID,
    booking_lifecycle_state: "terminal",
    night: "2026-08-08",
    occupied_beds_excluding_this_booking: 999,
    available_beds_excluding_this_booking: 999,
    party_beds_this_night: 999,
    spare_beds_after_this_booking: -999,
    fits_this_night: true,
    whole_lodge_held_by_another_booking: true,
    this_booking_effectively_holds_whole_lodge: true,
    this_booking_has_whole_lodge_hold_flag: true,
    capacity_overridden: true,
    allocated_bed_nights: 999,
    observed_at_utc: WIDEST_INSTANT,
  },
  [DIAGNOSTICS_MEMBER_ELIGIBILITY_TOOL_ID]: {
    member_id: WIDEST_RECORD_ID,
    lifecycle_label: "Cancelled",
    is_active: true,
    can_login: true,
    age_tier: "INFANT",
    season_year: 2026,
    membership_type_key: "SENIOR_FAMILY_MEMBERSHIP",
    membership_type_source: "built_in_default",
    membership_booking_behavior: "BLOCK_BOOKING",
    membership_subscription_behavior: "REQUIRED_BY_AGE_TIER",
    subscription_status: "NOT_INVOICED",
    subscription_paid_at_utc: WIDEST_INSTANT,
    subscription_manually_marked_paid: true,
    subscription_required: true,
    subscription_unpaid: true,
    subscription_lockout_mode: "NON_MEMBER_PRICING",
    qualifies_as_adult_member_host: true,
    requires_induction: true,
    induction_status: "AWAITING_SIGN_OFF",
    induction_gates_booking: false,
    hut_leader_eligible: true,
    // Every declared eligibility code at once, derived for the same reason.
    eligibility_codes: MEMBER_ELIGIBILITY_CODES.join(","),
    eligibility_code_count: MEMBER_ELIGIBILITY_CODES.length,
    observed_at_utc: WIDEST_INSTANT,
  },
};

/**
 * Representative VALID arguments for each entry, so the parameter-arity contract
 * below can actually reach `bind`. A new tool pack must add its own row — the test
 * fails loudly rather than skipping, because a skipped arity check is exactly how a
 * one-parameter-short entry would ship.
 */
const EXAMPLE_ARGS: Record<string, unknown> = {
  [DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID]: {},
  [DIAGNOSTICS_READINESS_TOOL_ID]: {},
  [DIAGNOSTICS_DEPLOYMENT_TOOL_ID]: {},
  [DIAGNOSTICS_USAGE_HEALTH_TOOL_ID]: {},
  [DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID]: {},
  // The AID-6A correlation entries all take the same argument shape, and every one
  // of them needs a row here or its parameter arity goes unchecked.
  ...Object.fromEntries(
    DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS.map((tool) => [
      tool.id,
      { window: "1h", requestId: "req-abc-123" },
    ]),
  ),
  // AID-6C (#2377). Every finance entry REQUIRES an argument — there is no blank
  // search and no per-record tool that takes nothing — so each one needs its own
  // row here, and `{}` would not parse for any of them.
  [DIAGNOSTICS_FINANCE_PAYMENT_SEARCH_TOOL_ID]: {
    referenceKind: "booking_reference",
    reference: "CLZ00000",
  },
  [DIAGNOSTICS_FINANCE_AMOUNT_SEARCH_TOOL_ID]: {
    amountCents: 12345,
    window: "30d",
  },
  [DIAGNOSTICS_PAYMENT_SUMMARY_TOOL_ID]: {
    paymentId: "clz0000000abcdefghijklmno",
  },
  [DIAGNOSTICS_PAYMENT_ATTEMPT_LEDGER_TOOL_ID]: {
    paymentId: "clz0000000abcdefghijklmno",
  },
  [DIAGNOSTICS_PAYMENT_REFUND_STATE_TOOL_ID]: {
    paymentId: "clz0000000abcdefghijklmno",
  },
  [DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID]: {
    provider: "stripe",
    eventRef: "evt_3Qabcdefghijklmnopqrstu",
  },
  [DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID]: {
    localModel: "Booking",
    localId: "clz0000000abcdefghijklmno",
  },
  [DIAGNOSTICS_XERO_CONTACT_LINKAGE_TOOL_ID]: {
    memberId: "clz0000000abcdefghijklmno",
  },
  [DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID]: {
    subject: "payment",
    recordId: "clz0000000abcdefghijklmno",
  },
  [DIAGNOSTICS_BOOKING_FINANCE_STATE_TOOL_ID]: {
    bookingId: "clz0000000abcdefghijklmno",
  },
  // AID-6B (#2376). Same rule as AID-6C: no entry in this pack takes a blank
  // argument object, so every one needs its own row. The two searches are
  // discriminated unions — the `kind` decides which term is required — and the
  // arm chosen here is deliberately the one with the MOST parameters, because an
  // arm that binds fewer would leave the wider arm's arity unchecked.
  [DIAGNOSTICS_BOOKING_SEARCH_TOOL_ID]: {
    kind: "lodge_nights",
    lodgeId: WIDEST_RECORD_ID,
    nightFrom: "2026-08-08",
    window: "30d",
  },
  [DIAGNOSTICS_MEMBER_SEARCH_TOOL_ID]: {
    kind: "name_prefix",
    namePrefix: "smi",
  },
  [DIAGNOSTICS_BOOKING_SUMMARY_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_BOOKING_LINKED_STATE_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_BOOKING_PARTY_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_BOOKING_BED_ALLOCATION_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_BOOKING_EXCEPTION_REQUEST_TOOL_ID]: {
    bookingId: WIDEST_RECORD_ID,
  },
  [DIAGNOSTICS_BOOKING_AUDIT_HISTORY_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_MEMBER_SUMMARY_TOOL_ID]: { memberId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_MEMBER_SUBSCRIPTION_STATE_TOOL_ID]: {
    memberId: WIDEST_RECORD_ID,
  },
  [DIAGNOSTICS_MEMBER_FAMILY_STATE_TOOL_ID]: { memberId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_MEMBER_BOOKING_SUMMARY_TOOL_ID]: { memberId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID]: {
    subject: "member",
    recordId: WIDEST_RECORD_ID,
  },
  // The three server-owned entries bind no SQL parameter, so the arity contract
  // skips them; they are here because the pack's own suite reuses this census to
  // prove every entry parses a realistic argument object.
  [DIAGNOSTICS_BOOKING_BLOCK_STATE_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_BOOKING_CAPACITY_TOOL_ID]: { bookingId: WIDEST_RECORD_ID },
  [DIAGNOSTICS_MEMBER_ELIGIBILITY_TOOL_ID]: { memberId: WIDEST_RECORD_ID },
};

/**
 * A throwaway entry built around a caller-supplied schema, so the NESTED argument
 * shapes below can actually be exercised.
 *
 * Every entry AID-5 ships takes `z.object({}).strict()`, which rejects a nested
 * argument on the schema alone — so a nested-key assertion against the shipped
 * registry cannot fail, whatever the guard does. That is exactly how a
 * depth-limited scan shipped green in the first place. This fixture is the same
 * `defineDiagnosticsTool` an author calls, with the argument shape the next tool
 * packs (AID-6B/#2376, AID-6C/#2377) need.
 */
function nestedArgumentFixture<TArgs>(argsSchema: z.ZodType<TArgs>) {
  return defineDiagnosticsTool<TArgs>({
    id: "diagnostics.nested_args_fixture",
    label: "Nested-argument fixture",
    description:
      "Test-only entry with a nested argument shape, used to pin the depth-total reserved-key scan.",
    requiredAreas: ["support"],
    source: "select_only_sql",
    argsSchema,
    inputSchema: {
      type: "object",
      properties: { filters: { type: "object" } },
      additionalProperties: false,
    },
    sql: "SELECT true AS ok",
    bind: () => [],
    project: (row: Record<string, unknown>) => ({ ok: row.ok === true }),
    rowLimit: 1,
    byteLimit: 64,
    surfacesPersonalData: false,
  });
}

/**
 * What zod ITSELF does with a polluted input, recorded per case because the
 * answers are different defects — and recorded as a MEASUREMENT rather than a
 * claim, because it has already changed underneath this file once.
 *
 * `ZOD_REJECTS` — zod refuses the input outright, so no repaired call exists to
 * hash. zod 4.5 moved every `.strict()` object shape here, at any depth and
 * inside array elements. Three rows below turned over when the dependency went
 * from 4.4.3 to 4.5.4, and it was this table that reported it (#3313).
 *
 * `ZOD_STRIPS` — zod accepts and silently DELETES the key, so the accepted
 * arguments are byte-identical to a call that never sent it and ADR-004's
 * durable `argsHash` cannot tell the two apart. That is the audit-integrity
 * defect this guard exists to remove. On zod 4.5.4 `z.record(...)` is the ONE
 * surviving shape — which is exactly the shape the next tool packs need, so the
 * guard is more load-bearing after the upgrade, not less.
 *
 * `ZOD_KEEPS` — zod accepts and keeps the key (measured: the canonical hashes
 * differ), so the record would at least be faithful. It is still an argument the
 * registry documents as a REJECTION, and the guard refuses it.
 */
type ZodReservedKeyVerdict =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly hashesAsIfAbsent: boolean };

const ZOD_REJECTS: ZodReservedKeyVerdict = { accepted: false };
const ZOD_STRIPS: ZodReservedKeyVerdict = {
  accepted: true,
  hashesAsIfAbsent: true,
};
const ZOD_KEEPS: ZodReservedKeyVerdict = {
  accepted: true,
  hashesAsIfAbsent: false,
};

/**
 * The nesting shapes a reserved key can hide in, each with a schema that would
 * ACCEPT the polluted input on its own where zod still does — so the guard
 * assertion is never satisfied by the schema instead of the guard. Where zod now
 * rejects the shape itself, the guard assertion still runs and still has to pass,
 * because the guard runs BEFORE the schema and must not have quietly become a
 * pass-through.
 */
interface NestedReservedKeyCase {
  label: string;
  polluted: string;
  clean: string;
  /** Measured on the resolved zod, not assumed. See `ZodReservedKeyVerdict`. */
  zod: ZodReservedKeyVerdict;
  /** The schema ALONE, to measure what zod does when nothing guards it. */
  parseWithSchemaOnly: (raw: unknown) => { success: boolean; data: unknown };
  /** The same schema behind `defineDiagnosticsTool`, which must refuse. */
  entry: DiagnosticsToolEntry;
}

/**
 * Built through a generic function rather than declared as a literal table: each
 * schema has a different argument type, and a single array literal would collapse
 * them into a union that no longer satisfies `z.ZodType<TArgs>`.
 */
function nestedReservedKeyCase<TArgs>(
  label: string,
  argsSchema: z.ZodType<TArgs>,
  polluted: string,
  clean: string,
  zod: ZodReservedKeyVerdict,
): NestedReservedKeyCase {
  return {
    label,
    polluted,
    clean,
    zod,
    parseWithSchemaOnly: (raw) => {
      const result = argsSchema.safeParse(raw);
      return {
        success: result.success,
        data: result.success ? result.data : undefined,
      };
    },
    entry: nestedArgumentFixture(argsSchema),
  };
}

const NESTED_RESERVED_KEY_CASES: readonly NestedReservedKeyCase[] = [
  nestedReservedKeyCase(
    "one object down",
    z
      .object({ filters: z.object({ status: z.string().optional() }).strict() })
      .strict(),
    '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
    '{"filters":{"status":"open"}}',
    ZOD_REJECTS,
  ),
  nestedReservedKeyCase(
    "in a `z.record(...)`, the shape the first tool pack needs",
    z.object({ filters: z.record(z.string(), z.string()) }).strict(),
    '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
    '{"filters":{"status":"open"}}',
    ZOD_STRIPS,
  ),
  nestedReservedKeyCase(
    "inside an ARRAY element",
    z
      .object({ filters: z.array(z.object({ status: z.string() }).strict()) })
      .strict(),
    '{"filters":[{"__proto__":{"polluted":"yes"},"status":"open"}]}',
    '{"filters":[{"status":"open"}]}',
    ZOD_REJECTS,
  ),
  nestedReservedKeyCase(
    "four levels down",
    z
      .object({
        a: z
          .object({
            b: z.object({ c: z.object({ d: z.string() }).strict() }).strict(),
          })
          .strict(),
      })
      .strict(),
    '{"a":{"b":{"c":{"__proto__":{"polluted":"yes"},"d":"x"}}}}',
    '{"a":{"b":{"c":{"d":"x"}}}}',
    ZOD_REJECTS,
  ),
  nestedReservedKeyCase(
    "as `constructor`, which zod KEEPS rather than strips",
    z.object({ filters: z.record(z.string(), z.string()) }).strict(),
    '{"filters":{"constructor":"x","status":"open"}}',
    '{"filters":{"status":"open"}}',
    ZOD_KEEPS,
  ),
  // The two rows below exist because zod 4.5 REMOVED coverage from this table
  // without removing any risk (#3313). Once zod began rejecting `.strict()`
  // object shapes itself, the "one object down", "ARRAY element" and "four levels
  // down" rows stopped discriminating: their schema refuses the input, so they
  // would still pass with the guard's depth traversal deleted. Re-nesting the one
  // shape zod still accepts — `z.record(...)` — puts DEPTH and ARRAY traversal
  // back under a schema that accepts the polluted input, so the guard is once
  // again the only thing that can reject it. Both are measured, not assumed:
  // zod 4.5.4 accepts each and hashes it byte-identically to the clean call.
  nestedReservedKeyCase(
    "in a `z.record(...)` THREE levels down, where only the guard can refuse it",
    z
      .object({ a: z.object({ b: z.record(z.string(), z.string()) }).strict() })
      .strict(),
    '{"a":{"b":{"__proto__":{"polluted":"yes"},"status":"open"}}}',
    '{"a":{"b":{"status":"open"}}}',
    ZOD_STRIPS,
  ),
  nestedReservedKeyCase(
    "in a `z.record(...)` inside an ARRAY, where only the guard can refuse it",
    z.object({ filters: z.array(z.record(z.string(), z.string())) }).strict(),
    '{"filters":[{"__proto__":{"polluted":"yes"},"status":"open"}]}',
    '{"filters":[{"status":"open"}]}',
    ZOD_STRIPS,
  ),
];

describe("diagnostics tool registry contract (#2374)", () => {
  it("registers at least one tool and no duplicate ids", () => {
    expect(DIAGNOSTICS_TOOLS.length).toBeGreaterThan(0);
    const ids = DIAGNOSTICS_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s has a well-formed id",
    (_id, tool) => {
      expect(isValidDiagnosticsToolId(tool.id)).toBe(true);
      expect(findDiagnosticsTool(tool.id)).toBe(tool);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s declares one of the two known evidence sources, and matches its shape",
    (_id, tool) => {
      // The discriminant is the registry's, not an argument's, and there are exactly
      // two kinds. A SQL entry carries a statement; a server-owned entry exposes no
      // handle on its source at all, so the only way to reach it is through the
      // closure `parseArgs` returns after the schema has accepted the arguments.
      expect(DIAGNOSTICS_TOOL_EVIDENCE_SOURCES).toContain(tool.source);
      if (tool.source === "select_only_sql") {
        expect(typeof tool.sql).toBe("string");
      } else {
        expect("sql" in tool).toBe(false);
        expect("readEvidence" in tool).toBe(false);
        expect("bind" in tool).toBe(false);
      }
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s requires at least one real admin area, and never `edit`",
    (_id, tool) => {
      // ADR-002 §2: a tool that required nothing would be a tool anyone may run.
      expect(tool.requiredAreas.length).toBeGreaterThan(0);
      for (const area of tool.requiredAreas) {
        expect(AREA_KEYS.has(area)).toBe(true);
      }
      // Diagnostics is read-only, so a level never appears in a requirement —
      // the substrate always checks `view`.
      expect(JSON.stringify(tool.requiredAreas)).not.toContain("edit");
    },
  );

  it.each(SQL_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s carries exactly one SELECT statement",
    (_id, tool) => {
      const trimmed = tool.sql.trim();
      expect(trimmed).toMatch(/^(SELECT|WITH)\b/i);
      // No semicolon: the executor wraps the SQL in a LIMIT subquery, which is
      // only safe for a single statement.
      expect(trimmed).not.toContain(";");
      expect(trimmed.length).toBeGreaterThan(0);
    },
  );

  it.each(
    SQL_TOOLS.filter((tool) => tool.rowLimit > 1).map(
      (tool) => [tool.id, tool] as const,
    ),
  )(
    "%s can return several rows, so it orders them deterministically",
    (_id, tool) => {
      // Checklist item 7, enforced rather than trusted, and only meaningful once a
      // pack registers a multi-row entry — AID-6A's correlation tools are the first.
      // Without a total `ORDER BY`, PostgreSQL may hand identical evidence back in a
      // different order run to run, and the audit `resultHash` — the hash of the
      // projected rows IN ORDER — would then differ for the same answer, which
      // destroys the one question that hash exists to settle.
      expect(tool.sql.toUpperCase()).toContain("ORDER BY");
      // At least two ordering keys, because the leading key of a time-ordered read is
      // never unique: a tiebreaker is what makes the order total.
      const orderBy = tool.sql.slice(tool.sql.toUpperCase().lastIndexOf("ORDER BY"));
      expect(
        orderBy.split(",").length,
        `${tool.id} orders by one key only: ${orderBy}`,
      ).toBeGreaterThan(1);
    },
  );

  it.each(SQL_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s contains no mutating, DDL, file-reading or locking SQL",
    (_id, tool) => {
      for (const pattern of FORBIDDEN_TOOL_SQL_PATTERNS) {
        expect(
          pattern.test(tool.sql),
          `${tool.id} SQL matches forbidden pattern ${pattern}`,
        ).toBe(false);
      }
    },
  );

  // NEGATIVE CONTROL for the test above. Iterating the exported pattern list and
  // asserting nothing matches would pass just as happily if the list were empty or
  // half-deleted, so this pins that the list actually catches the statements it
  // exists to catch. Without it, "no entry contains a DELETE" is a claim about the
  // list's contents that no test checks.
  it.each([
    ["INSERT INTO public.\"Member\" (id) VALUES ($1)"],
    ["UPDATE public.\"Member\" SET email = $1"],
    ["DELETE FROM public.\"Member\" WHERE id = $1"],
    ["TRUNCATE public.\"Member\""],
    ["DROP TABLE public.\"Member\""],
    ["CREATE TEMP TABLE leak (id int)"],
    ["ALTER TABLE public.\"Member\" ADD COLUMN x text"],
    ["GRANT SELECT ON public.\"Member\" TO someone"],
    ["REVOKE SELECT ON public.\"Member\" FROM someone"],
    ["COPY public.\"Member\" TO '/tmp/leak.csv'"],
    ["VACUUM public.\"Member\""],
    ["SELECT pg_read_file('/etc/passwd')"],
    ["SELECT pg_read_binary_file('/etc/passwd')"],
    ["SELECT pg_ls_dir('/')"],
    ["SELECT lo_import('/etc/passwd')"],
    ["SELECT lo_export(1, '/tmp/leak')"],
    ["SELECT pg_sleep(30)"],
    ["SELECT pg_advisory_lock(1)"],
    ["SELECT dblink('', 'SELECT 1')"],
    ["SELECT id FROM public.\"Member\" FOR UPDATE"],
    ["SELECT id FROM public.\"Member\" FOR SHARE"],
    ["SET LOCAL statement_timeout = 0"],
    ["SET SESSION default_transaction_read_only = off"],
    // Comments would break the executor's LIMIT wrapper.
    ["SELECT 1 -- trailing comment"],
    ["SELECT 1 /* block comment */"],
  ])("the forbidden-pattern list catches %s", (hostileSql) => {
    expect(
      FORBIDDEN_TOOL_SQL_PATTERNS.some((pattern) => pattern.test(hostileSql)),
    ).toBe(true);
  });

  it.each(SQL_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s has balanced parentheses so the executor's LIMIT wrapper still parses",
    (_id, tool) => {
      // The row cap is applied by wrapping the entry's SQL in
      // `SELECT * FROM (<sql>) AS ... LIMIT ($n)`. A stray closing parenthesis
      // would close that wrapper early; a stray opening one would swallow it.
      let depth = 0;
      for (const character of tool.sql) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        expect(depth, `${tool.id} SQL closes a parenthesis it never opened`)
          .toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${tool.id} SQL leaves a parenthesis open`).toBe(0);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s declares row and byte limits within the hard ceilings",
    (_id, tool) => {
      expect(tool.rowLimit).toBeGreaterThan(0);
      expect(tool.rowLimit).toBeLessThanOrEqual(DIAGNOSTICS_TOOL_BOUNDS.maxRows);
      expect(tool.byteLimit).toBeGreaterThan(0);
      expect(tool.byteLimit).toBeLessThanOrEqual(
        DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes,
      );
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s declares a byte limit its own row limit can ACHIEVE",
    (_id, tool) => {
      // The assertion that was missing. `byteLimit <= maxResultBytes` says a ceiling is
      // legal; it does not say a full result fits under it. An entry whose own
      // `rowLimit` rows exceed its own `byteLimit` is not "bounded" — it is BROKEN, and
      // broken silently, because gate 9 refuses the whole result with
      // `result_too_large` and tells the operator to narrow a question that in three of
      // these entries takes no arguments at all.
      const raw = EXAMPLE_RAW_ROWS[tool.id];
      expect(raw, `${tool.id} has no EXAMPLE_RAW_ROWS entry`).toBeDefined();
      const rows = Array.from({ length: tool.rowLimit }, () => tool.project(raw));
      const byteCount = Buffer.byteLength(canonicalStringify(rows), "utf8");
      expect(
        byteCount,
        `${tool.id}: ${tool.rowLimit} rows serialise to ${byteCount} bytes, over its ${tool.byteLimit} byteLimit`,
      ).toBeLessThanOrEqual(tool.byteLimit);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s stays HONEST about its rows when the evidence block has to clip them",
    (_id, tool) => {
      // The rendered block is the OTHER ceiling, and the one an earlier revision got
      // wrong by estimating ~230 characters a row: 30 correlation rows of real action
      // codes rendered to exactly 8 000 characters, three rows silently gone and a
      // fourth cut mid-field, under a header still claiming 30.
      //
      // At the WIDEST widths below a clip is legitimate — a member can plant
      // 128-character request ids on every row — so what this asserts is not that
      // everything fits but that the block never lies about what it listed. Each pack's
      // own test asserts the full row limit renders at TYPICAL widths.
      const raw = EXAMPLE_RAW_ROWS[tool.id];
      expect(raw, `${tool.id} has no EXAMPLE_RAW_ROWS entry`).toBeDefined();
      const rows = Array.from({ length: tool.rowLimit }, () => tool.project(raw));
      const block = renderToolResultEvidenceBlock({
        schemaVersion: 1,
        status: "ok",
        toolId: tool.id,
        label: tool.label,
        rows,
        truncated: true,
        ...(tool.evidenceScope ? { evidenceScope: tool.evidenceScope } : {}),
        observedAt: "2026-08-03T09:00:00.000Z",
        audit: {
          toolId: tool.id,
          areasChecked: [...tool.requiredAreas],
          authOutcome: "allowed",
          failureReason: null,
          argsHash: "a".repeat(64),
          resultHash: "b".repeat(64),
          rowCount: rows.length,
          byteCount: 0,
          durationMs: 1,
          roundIndex: 0,
          observedAt: "2026-08-03T09:00:00.000Z",
          invocationChannel: "model_tool_use",
          sensitiveInclusion: "not_applicable",
          consentRecordKind: null,
          consentRecordOrigin: null,
          peopleSearchTick: "withheld",
          recordConsentTick: "withheld",
        },
      });
      expect(block.length).toBeLessThanOrEqual(
        DIAGNOSTICS_TOOL_BOUNDS.renderedBlockMaxChars,
      );
      const rowLines = block.split("\n").filter((line) => /^- \d+\./.test(line));
      expect(rowLines.length).toBeGreaterThan(0);
      expect(rowLines.length).toBeLessThanOrEqual(tool.rowLimit);

      // The stated count matches the lines present, whether or not it clipped.
      expect(block).toContain(
        rowLines.length === rows.length
          ? `rows (${rows.length}):`
          : `rows (${rowLines.length} of ${rows.length} listed`,
      );
      // And no listed row is partial: every one ends on a complete `key=value`.
      for (const line of rowLines) {
        expect(line, `${tool.id}: ${line}`).toMatch(
          /^- \d+\. (?:[A-Za-z0-9]+=(?:"[^"]*"|true|false|null|-?\d+(?:\.\d+)?); )*[A-Za-z0-9]+=(?:"[^"]*"|true|false|null|-?\d+(?:\.\d+)?)$/,
        );
      }
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s reads every key its EXAMPLE_RAW_ROWS fixture supplies, and supplies every key it reads",
    (_id, tool) => {
      // THE FIXTURE IS THE MEASUREMENT, NOT AN ILLUSTRATION. `tools.md` says so in
      // as many words: "Measure rowLimit and byteLimit; do not estimate them. Add
      // the entry's widest realistic raw row to EXAMPLE_RAW_ROWS." So a key the
      // projection does not read is not a harmless extra — it means the field it was
      // meant to size is being measured at its FALLBACK instead, and the ceiling this
      // suite certifies as measured is short by however wide the real value is.
      //
      // It has already happened once. An alias rename in `booking_search`
      // (`whole_lodge_hold` -> `whole_lodge_hold_flag_stored`) left the fixture on
      // the old key; the fallback there was `boolOf`, so the effect was one byte in
      // the SAFE direction and nobody noticed. The next rename on a field whose
      // fallback is `null` — `instantOrNull`, `recordRefOrNull`, `personNameOrNull`,
      // `centsOrNull`, all the wide ones — would take up to 200 characters out of
      // the measurement while `byteLimit` stayed put, and gate 9 would refuse the
      // entry in production against a ceiling the suite had certified.
      //
      // Both directions are asserted. Neither is catchable by TypeScript:
      // `EXAMPLE_RAW_ROWS` is `Record<string, unknown>` and `project` takes the same,
      // so an unread key and a missing key are both perfectly well typed.
      const raw = EXAMPLE_RAW_ROWS[tool.id] as Record<string, unknown>;
      const read = new Set<string>();
      tool.project(
        new Proxy(raw, {
          get: (target, property) => {
            if (typeof property === "string") read.add(property);
            return Reflect.get(target, property);
          },
          has: (target, property) => {
            if (typeof property === "string") read.add(property);
            return Reflect.has(target, property);
          },
        }),
      );
      expect(
        [...Object.keys(raw)].filter((key) => !read.has(key)).sort(),
        `${tool.id}: fixture keys its projection never reads — the alias was renamed, or the key was never real`,
      ).toEqual([]);
      expect(
        [...read].filter((key) => !(key in raw)).sort(),
        `${tool.id}: keys the projection reads that the widest-row fixture does not supply, so those fields are measured at their fallback`,
      ).toEqual([]);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s leaves a QUARTER of the rendered budget for evidence, not just a byte",
    (_id, tool) => {
      const raw = EXAMPLE_RAW_ROWS[tool.id] as Record<string, unknown>;
      // THE CLIFF THE TEST ABOVE FALLS OFF WITHOUT WARNING. "At least one row
      // rendered" is an all-or-nothing assertion: an entry can sit one character
      // inside it for releases and then lose its whole evidence block to a
      // three-sentence scope edit, with the only symptom a suite that suddenly says
      // `expected 0 to be greater than 0`. It is not hypothetical — AID-6B put a
      // 3,101-character code catalogue in one entry's SCOPE and the empty block came
      // to 7,545 of 8,000, which is the measurement `docs/ai-diagnostics/tools.md`
      // records and the reason those sentences travel in the entry DESCRIPTION now.
      //
      // So the fixed cost is bounded instead: everything the block carries before a
      // single row — the header, the scope, the audit footer — must leave a QUARTER
      // of the budget for the rows the tool exists to return. The description is
      // deliberately NOT part of this: it reaches the model through the tool
      // definition and costs this block nothing, which is exactly why it is where a
      // long code catalogue belongs.
      const fixedCost = renderToolResultEvidenceBlock({
        schemaVersion: 1,
        status: "ok",
        toolId: tool.id,
        label: tool.label,
        rows: [],
        truncated: false,
        ...(tool.evidenceScope ? { evidenceScope: tool.evidenceScope } : {}),
        observedAt: "2026-08-03T09:00:00.000Z",
        audit: {
          toolId: tool.id,
          areasChecked: [...tool.requiredAreas],
          authOutcome: "allowed",
          failureReason: null,
          argsHash: "a".repeat(64),
          resultHash: "b".repeat(64),
          rowCount: 0,
          byteCount: 0,
          durationMs: 1,
          roundIndex: 0,
          observedAt: "2026-08-03T09:00:00.000Z",
          invocationChannel: "model_tool_use",
          sensitiveInclusion: "not_applicable",
          consentRecordKind: null,
          consentRecordOrigin: null,
          peopleSearchTick: "withheld",
          recordConsentTick: "withheld",
        },
      }).length;
      const oneRow = renderToolResultEvidenceBlock({
        schemaVersion: 1, status: "ok", toolId: tool.id, label: tool.label,
        rows: [tool.project(raw)], truncated: false,
        ...(tool.evidenceScope ? { evidenceScope: tool.evidenceScope } : {}),
        observedAt: "2026-08-03T09:00:00.000Z",
        audit: { toolId: tool.id, areasChecked: [...tool.requiredAreas], authOutcome: "allowed",
          failureReason: null, argsHash: "a".repeat(64), resultHash: "b".repeat(64),
          rowCount: 1, byteCount: 0, durationMs: 1, roundIndex: 0, observedAt: "2026-08-03T09:00:00.000Z",
          invocationChannel: "model_tool_use", sensitiveInclusion: "not_applicable",
          consentRecordKind: null, consentRecordOrigin: null, recordConsentTick: "withheld",
          peopleSearchTick: "withheld" },
      }).length;
      const rowCost = oneRow - fixedCost;
      // The bound, stated as the thing that actually breaks: the fixed cost plus ONE
      // of this entry's widest rows, plus 400 characters of slack so the guard fires
      // BEFORE the cliff rather than on it. Measured at this head, the two tightest
      // entries are `booking_block_state` (6,412 + 1,101 = 7,513) and
      // `booking_capacity_by_night` (6,666 + 451 = 7,117), so the slack is real and
      // the guard is not vacuous for anything else either.
      expect(
        fixedCost + rowCost,
        `${tool.id} spends ${fixedCost} characters before its first row and ${rowCost} on the row itself, of ${DIAGNOSTICS_TOOL_BOUNDS.renderedBlockMaxChars}; move guidance out of evidenceScope and into the entry description, which reaches the model through the tool definition and costs this block nothing`,
      ).toBeLessThanOrEqual(DIAGNOSTICS_TOOL_BOUNDS.renderedBlockMaxChars - 400);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s REJECTS an unknown argument rather than ignoring it",
    (_id, tool) => {
      // The behavioural equivalent of asserting `.strict()`, and a better test:
      // it holds however the schema is written.
      expect(tool.parseArgs({ __unexpected__: 1 }).ok).toBe(false);
      expect(tool.parseArgs({ toolId: "x" }).ok).toBe(false);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s REJECTS a reserved key that `.strict()` alone would silently strip",
    (_id, tool) => {
      // `.strict()` is not total. Measured on zod 4.4.3:
      // `z.object({}).strict().safeParse(JSON.parse('{"__proto__":{}}'))` SUCCEEDS
      // with `data: {}` and reports no unrecognized key. The arguments reaching
      // `parseArgs` are the model's `tool_use` input deserialised from provider
      // JSON, so `__proto__` arrives as an ordinary own property exactly like this.
      // Accepting it makes the audit `argsHash` identical to a call that sent `{}`,
      // so ADR-004's durable record cannot tell the two apart — and the first entry
      // with a `z.record(...)` field would silently drop a filter key.
      expect(tool.parseArgs(JSON.parse('{"__proto__":{"polluted":"yes"}}')).ok).toBe(
        false,
      );
      expect(tool.parseArgs(JSON.parse('{"constructor":{}}')).ok).toBe(false);
      expect(tool.parseArgs(JSON.parse('{"prototype":{}}')).ok).toBe(false);
      // And nothing was polluted on the way past.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s REJECTS a reserved key at ANY depth, in an object or an array",
    (_id, tool) => {
      // A top-level-only scan is not the guarantee the registry documents. Zod strips
      // a NESTED `__proto__` exactly as readily as a top-level one, so a guard that
      // stopped at depth 1 would reproduce the same audit-hash defect one level down —
      // measured by the `NESTED_RESERVED_KEY_CASES` table below, which uses a fixture
      // entry because no entry shipped today takes a nested argument. These inputs
      // therefore fail on this entry's schema as well; the assertions exist so the
      // first tool pack with a `filters` object inherits a scan that already looks
      // everywhere, and they will bite the moment such an entry is registered.
      for (const raw of [
        '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
        '{"filters":[{"__proto__":{"polluted":"yes"}}]}',
        '{"a":{"b":{"c":{"d":{"__proto__":{}}}}}}',
        '{"a":[[{"constructor":{}}]]}',
        '{"a":{"b":{"prototype":{}}}}',
      ]) {
        expect(tool.parseArgs(JSON.parse(raw)).ok, raw).toBe(false);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each(NESTED_RESERVED_KEY_CASES.map((entry) => [entry.label, entry] as const))(
    "refuses a reserved key %s, whatever zod itself does with it",
    (_label, testCase) => {
      const polluted: unknown = JSON.parse(testCase.polluted);
      const clean: unknown = JSON.parse(testCase.clean);

      // 1. What zod does with the polluted input UNGUARDED. This is the
      //    measurement, not a claim, and it is asserted in both directions so a
      //    zod that changes its mind in EITHER direction reports it here rather
      //    than passing silently. That is not hypothetical: zod 4.5 began
      //    rejecting every `.strict()` object shape, at any depth and inside an
      //    array element, and these three assertions are what caught it (#3313).
      const pollutedParse = testCase.parseWithSchemaOnly(polluted);
      const cleanParse = testCase.parseWithSchemaOnly(clean);
      expect(pollutedParse.success).toBe(testCase.zod.accepted);
      // The clean input must parse in every case. If it ever stops, the polluted
      // assertion above is passing for the wrong reason — the schema rejecting
      // the SHAPE rather than zod rejecting the KEY.
      expect(cleanParse.success).toBe(true);

      // 2. Where zod ACCEPTS the key it repairs the arguments silently, so the
      //    durable `argsHash` — which `invoke.ts` computes as
      //    `sha256Hex(canonicalStringify(binding.args))` — is BYTE-IDENTICAL for a
      //    call that sent the reserved key and one that did not. That is the
      //    audit-integrity defect this guard exists to remove. On zod 4.5.4 the
      //    only shape where it still bites is `z.record(...)`, and a record-shaped
      //    `filters` argument is precisely what the next tool packs need.
      if (testCase.zod.accepted && pollutedParse.success && cleanParse.success) {
        const pollutedHash = sha256Hex(canonicalStringify(pollutedParse.data));
        const cleanHash = sha256Hex(canonicalStringify(cleanParse.data));
        if (testCase.zod.hashesAsIfAbsent) {
          expect(pollutedHash).toBe(cleanHash);
        } else {
          expect(pollutedHash).not.toBe(cleanHash);
        }
      }

      // 3. `parseArgs` is what makes the rejection total, and it must hold whether
      //    or not zod would have caught the key on its own.
      //
      //    BE HONEST ABOUT WHICH ROWS PROVE WHAT. This assertion discriminates
      //    only where `zod.accepted` is true: there the schema would have taken
      //    the input, so the guard is the sole thing that can refuse it. On a row
      //    zod now rejects, the schema alone would fail the parse and this line
      //    passes whatever the guard does — it is a regression tripwire for zod,
      //    not evidence about the scan. The depth-total and array traversal are
      //    proven by the `z.record(...)` rows above, which is exactly why the
      //    nested and in-array record rows were added when zod 4.5 landed.
      expect(testCase.entry.parseArgs(polluted).ok).toBe(false);
      expect(testCase.entry.parseArgs(clean).ok).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it("terminates on a cyclic object rather than spinning in the reserved-key scan", () => {
    // `parseArgs` takes `unknown`. JSON cannot carry a cycle, but the type says
    // nothing about that, and an iterative scan without a visited set would hang the
    // request thread instead of refusing.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const tool = DIAGNOSTICS_TOOLS[0];
    expect(tool.parseArgs(cyclic).ok).toBe(false);
  });

  it.each(SQL_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s binds exactly the parameters its SQL references — $1..$N, no gaps",
    (_id, tool) => {
      // The executor appends the row cap as `$${params.length + 1}`, which is
      // correct only while the entry references exactly `$1..$N`. One parameter
      // short does NOT fail at the database: verified on postgres:16, the row cap
      // silently serves as the missing placeholder and the query returns rows, so
      // the tool's own predicate is evaluated against the row cap and the result is
      // projected, hashed and audited as a clean success.
      const example = EXAMPLE_ARGS[tool.id];
      expect(
        example,
        `add an EXAMPLE_ARGS row for ${tool.id} so its parameter arity is checked`,
      ).toBeDefined();
      const binding = tool.parseArgs(example);
      expect(binding.ok, `${tool.id} rejected its own EXAMPLE_ARGS`).toBe(true);
      if (!binding.ok || binding.source !== "select_only_sql") return;

      const referenced = [...new Set(readSqlPlaceholderNumbers(tool.sql))].sort(
        (a, b) => a - b,
      );
      expect(referenced).toEqual(
        binding.params.map((_value: unknown, index: number) => index + 1),
      );
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s exposes a closed JSON schema to the provider",
    (_id, tool) => {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      // Every declared `required` name must be a declared property.
      for (const name of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(name);
      }
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.label.length).toBeGreaterThan(0);
    },
  );

  it.each(DIAGNOSTICS_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s describes every advertised property, and a zero-argument tool accepts {}",
    (_id, tool) => {
      // The JSON Schema handed to the provider is hand-written while the Zod schema
      // is the real gate, so the two can drift. This pins what is checkable from
      // outside the entry: every advertised property is actually described (a bare
      // `{}` property tells the model nothing and invites a guessed value), and a
      // tool advertising NO properties must accept an empty argument object —
      // otherwise the model can never call it successfully at all.
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        expect(
          schema,
          `${tool.id} advertises "${name}" with no description of its shape`,
        ).toMatchObject({ type: expect.any(String) });
      }
      if (Object.keys(tool.inputSchema.properties).length === 0) {
        expect(tool.parseArgs({}).ok).toBe(true);
        // …and still refuses anything else, which is the `.strict()` property.
        expect(tool.parseArgs({ anything: 1 }).ok).toBe(false);
      }
    },
  );

  it("rejects malformed tool ids", () => {
    for (const candidate of [
      "",
      "Diagnostics.Probe",
      "diagnostics probe",
      "diagnostics/probe",
      "../../etc/passwd",
      "diagnostics.probe;DROP",
      "a".repeat(DIAGNOSTICS_TOOL_BOUNDS.toolIdMaxChars + 1),
    ]) {
      expect(isValidDiagnosticsToolId(candidate)).toBe(false);
    }
  });

  it("returns undefined for an unknown id rather than a default tool", () => {
    expect(findDiagnosticsTool("diagnostics.does_not_exist")).toBeUndefined();
    expect(findDiagnosticsTool("")).toBeUndefined();
  });
});

describe("ADR-004 §1 consent declarations (#2785)", () => {
  const PERSONAL_DATA_TOOLS = DIAGNOSTICS_TOOLS.filter(
    (tool) => tool.surfacesPersonalData,
  );

  it("has personal-data entries to check, so nothing below is vacuous", () => {
    expect(PERSONAL_DATA_TOOLS.length).toBeGreaterThan(10);
  });

  it.each(PERSONAL_DATA_TOOLS.map((tool) => [tool.id, tool] as const))(
    "%s names the record it is about, or declares itself a search",
    (_id, tool) => {
      // The gate `invoke.ts` runs has exactly two shapes — "did the operator include
      // THIS record" and "did the operator allow searching" — so an entry that
      // surfaces personal data and declares neither would have no gate at all.
      // `defineDiagnosticsTool` throws on it; this is the same rule asserted over the
      // registry that actually ships.
      const namesRecord = declaresConsentRecord(tool);
      expect(namesRecord || tool.operatorOnly === true).toBe(true);
      expect(namesRecord && tool.operatorOnly === true).toBe(false);
    },
  );

  it("pins the PER-RECORD entries that surface no personal data (#2785 review)", () => {
    // These six read about one identified subject and return only codes, amounts and
    // instants, so they declared `surfacesPersonalData: false` and sat outside the
    // consent gate entirely — the model could read the refund history of a payment
    // the ledger had just refused. Five of them now name their record; the sixth is
    // keyed on a PROVIDER event reference, which is not a record an operator can
    // select or a kind the ledger can hold, and its entry says so in as many words.
    const perRecordNonPersonal = DIAGNOSTICS_TOOLS.filter(
      (tool) => !tool.surfacesPersonalData && declaresConsentRecord(tool),
    ).map((tool) => tool.id);
    expect(perRecordNonPersonal.sort()).toEqual(
      [
        DIAGNOSTICS_PAYMENT_REFUND_STATE_TOOL_ID,
        DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID,
        DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID,
        DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID,
        DIAGNOSTICS_BOOKING_AUDIT_HISTORY_TOOL_ID,
      ].sort(),
    );
    const webhook = findDiagnosticsTool(
      DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID,
    );
    expect(webhook && declaresConsentRecord(webhook)).toBe(false);
  });

  /**
   * The registry-side half of the record-scope forcing function (#2785 delta review).
   *
   * `defineDiagnosticsTool` enforces the rule from the entry's ZOD schema at
   * definition time. This census enforces the same rule over the registry that
   * actually ships, by a DIFFERENT mechanism — the hand-written `inputSchema.required`
   * list (the bytes the provider is handed) and the entry's own `parseArgs` — so the
   * two cannot both stop working for one reason. It is also what makes the definer's
   * detector non-vacuous: if the probe stopped recognising identifiers, this
   * population would collapse and the count assertion below would fail.
   */
  function requiredIdentifierArgs(tool: DiagnosticsToolEntry): string[] {
    const example = EXAMPLE_ARGS[tool.id];
    if (typeof example !== "object" || example === null) return [];
    const keys: string[] = [];
    for (const key of tool.inputSchema.required ?? []) {
      const acceptsId = tool.parseArgs({
        ...example,
        [key]: WIDEST_RECORD_ID,
      }).ok;
      const refusesText = !tool.parseArgs({
        ...example,
        [key]: "not a record id!",
      }).ok;
      if (acceptsId && refusesText) keys.push(key);
    }
    return keys;
  }

  it("makes every entry asked about ONE identified thing answer for it (#2785 delta review)", () => {
    // The rule, over the registry rather than over one spec: an entry with a required
    // argument that takes an exact identifier either names the record it is about, is
    // a search governed by the channel gate, or carries a reviewed exemption saying
    // why what it names is not a record an operator could have included. Nothing may
    // simply not answer — that is how five per-record entries came to sit outside the
    // consent gate in the first place.
    const perRecordEntries = DIAGNOSTICS_TOOLS.filter(
      (tool) => requiredIdentifierArgs(tool).length > 0,
    );
    // Non-vacuity, and the detector's own alarm: this population is most of the
    // registry, so a probe that stopped recognising identifiers fails here.
    expect(perRecordEntries.length).toBeGreaterThan(15);

    for (const tool of perRecordEntries) {
      const answered =
        declaresConsentRecord(tool) ||
        tool.operatorOnly === true ||
        (tool.consentRecordExemption ?? "").trim().length > 0;
      expect(
        answered,
        `${tool.id} takes ${requiredIdentifierArgs(tool).join(", ")} but names no consent record, is no search, and carries no consentRecordExemption`,
      ).toBe(true);
    }
  });

  it("pins the ONE reviewed exemption, and what it says (#2785 delta review)", () => {
    // A census, not a ceiling — but a second one has to be added here in the same
    // diff, which is the review step the exemption exists to force. The webhook
    // timeline is keyed on a provider event reference: not a platform record id, not
    // something an operator can select, and not a kind the ledger can hold, so
    // declaring a record kind for it would refuse every invocation while looking like
    // a gate.
    const exempt = DIAGNOSTICS_TOOLS.filter(
      (tool) => tool.consentRecordExemption !== undefined,
    );
    expect(exempt.map((tool) => tool.id)).toEqual([
      DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID,
    ]);
    const webhook = exempt[0];
    expect(webhook?.consentRecordExemption).toMatch(/provider event reference/i);
    // The exemption is not a way to be gated more loosely: the entry still declares
    // no consent record, still surfaces no personal data, and still cannot widen the
    // investigation.
    expect(declaresConsentRecord(webhook!)).toBe(false);
    expect(webhook?.surfacesPersonalData).toBe(false);
    expect(webhook?.relatedRecordRefs).toBeUndefined();
  });

  it("pins the entries whose record KIND is an argument (#2785 review)", () => {
    // A static kind cannot express `{subject, recordId}` or `{localModel, localId}`,
    // and declaring one anyway would gate every subject as the wrong kind. The map is
    // exhaustive over the argument's own enum by definition-time invariant; this is
    // the census that a new one has to be added here in the same diff.
    const byArg = DIAGNOSTICS_TOOLS.filter(
      (tool) => tool.consentRecordKindByArg !== undefined,
    );
    expect(byArg.map((tool) => tool.id).sort()).toEqual(
      [
        DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID,
        DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID,
        DIAGNOSTICS_MEMBER_AUDIT_HISTORY_TOOL_ID,
      ].sort(),
    );
    for (const tool of byArg) {
      // Every mapped value is a real kind or a deliberate `null` refusal, and at
      // least one is a real kind — a map of nothing but nulls is an entry no
      // investigation could ever run, which is a mistake rather than a policy.
      const values = Object.values(tool.consentRecordKindByArg?.kinds ?? {});
      expect(values.length, tool.id).toBeGreaterThan(1);
      for (const value of values) {
        if (value === null) continue;
        expect(DIAGNOSTICS_CONSENT_RECORD_KINDS, tool.id).toContain(value);
      }
      expect(
        values.some((value) => value !== null),
        `${tool.id} maps every subject to null, so it can never run`,
      ).toBe(true);
    }
  });

  it("pins the operator-only entries — the four that SEARCH", () => {
    // A census, not a ceiling. A fifth search entry has to be added here in the same
    // diff, and an entry that quietly stops being operator-only fails this.
    expect(
      DIAGNOSTICS_TOOLS.filter((tool) => tool.operatorOnly === true)
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(
      [
        DIAGNOSTICS_BOOKING_SEARCH_TOOL_ID,
        DIAGNOSTICS_MEMBER_SEARCH_TOOL_ID,
        DIAGNOSTICS_FINANCE_PAYMENT_SEARCH_TOOL_ID,
        DIAGNOSTICS_FINANCE_AMOUNT_SEARCH_TOOL_ID,
      ].sort(),
    );
  });

  it.each(
    DIAGNOSTICS_TOOLS.filter(
      (tool) => tool.consentRecordArgKey !== undefined,
    ).map((tool) => [tool.id, tool] as const),
  )(
    "%s declares an argument key its OWN schema accepts as the record id",
    (_id, tool) => {
      // A declared key the schema never produces would refuse every invocation of the
      // entry — fail-closed, but silently and permanently. `EXAMPLE_ARGS` is the
      // census of a realistic argument object per entry, so this checks the
      // declaration against arguments the entry actually accepts.
      const key = tool.consentRecordArgKey;
      const example = EXAMPLE_ARGS[tool.id];
      expect(example, `add an EXAMPLE_ARGS row for ${tool.id}`).toBeDefined();
      const binding = tool.parseArgs(example);
      expect(binding.ok, `${tool.id} rejected its own EXAMPLE_ARGS`).toBe(true);
      if (!binding.ok) return;
      const record = consentedRecordForToolCall(tool, binding.args);
      expect(
        record,
        `${tool.id} declares ${key} but its accepted arguments carry no such record id`,
      ).not.toBeNull();
      expect(record?.id, tool.id).toBe(WIDEST_RECORD_ID);
      // The kind is the entry's own when it declares one, and the resolved one when
      // the entry chooses it per invocation — either way it must be a kind the ledger
      // can actually hold, or the gate has nothing to compare against.
      if (tool.consentRecordKind !== undefined) {
        expect(record?.kind, tool.id).toBe(tool.consentRecordKind);
      }
      expect(DIAGNOSTICS_CONSENT_RECORD_KINDS, tool.id).toContain(record?.kind);
    },
  );

  it("pins the entries that WIDEN the investigation — the ten with related refs", () => {
    // An exact-set census, and its absence was a real hole (#2785 review): the block
    // below is an `it.each` over a filtered population, and `it.each([])` registers
    // ZERO tests and reports green. Delete every `relatedRecordRefs` declaration in
    // the tree and nothing else would have failed — `defineDiagnosticsTool` treats
    // the field as optional, the ledger's own unit tests use hand-written fixtures,
    // and the real-registry executor tests assert only `status`. The flagship derived
    // flow (booking -> ownerMemberRef -> member_eligibility_state), which is the
    // entire reason consent is a ledger rather than one {kind, id} pair, would have
    // silently stopped working on every shipped entry.
    expect(
      DIAGNOSTICS_TOOLS.filter((tool) => tool.relatedRecordRefs !== undefined)
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(
      [
        DIAGNOSTICS_BOOKING_BLOCK_STATE_TOOL_ID,
        DIAGNOSTICS_BOOKING_SUMMARY_TOOL_ID,
        DIAGNOSTICS_BOOKING_PARTY_TOOL_ID,
        DIAGNOSTICS_BOOKING_LINKED_STATE_TOOL_ID,
        DIAGNOSTICS_BOOKING_EXCEPTION_REQUEST_TOOL_ID,
        DIAGNOSTICS_MEMBER_SUMMARY_TOOL_ID,
        DIAGNOSTICS_MEMBER_FAMILY_STATE_TOOL_ID,
        DIAGNOSTICS_MEMBER_BOOKING_SUMMARY_TOOL_ID,
        DIAGNOSTICS_PAYMENT_SUMMARY_TOOL_ID,
        DIAGNOSTICS_BOOKING_FINANCE_STATE_TOOL_ID,
      ].sort(),
    );
  });

  it("lets only a reviewed consent surface widen the ledger (#2785 review)", () => {
    // Absorbing extends the set of records the personal-data entries may then read,
    // so the entry doing the widening has to be one somebody reviewed as a consent
    // surface. Without this, a future non-personal linkage entry could seed member
    // ids into the ledger while declaring itself outside the consent story entirely.
    for (const tool of DIAGNOSTICS_TOOLS) {
      if (tool.relatedRecordRefs === undefined) continue;
      expect(tool.surfacesPersonalData, tool.id).toBe(true);
    }
  });

  it.each(
    DIAGNOSTICS_TOOLS.filter((tool) => tool.relatedRecordRefs !== undefined).map(
      (tool) => [tool.id, tool] as const,
    ),
  )("%s declares related refs its OWN projection produces", (_id, tool) => {
    // The ledger reads these fields out of the PROJECTED row, so a declared field the
    // projection does not emit is a declaration that can never fire — the ledger would
    // silently fail to follow a link the entry was written to expose. Every projection
    // is a fixed object literal, so projecting an empty raw row still yields the full
    // key set.
    const projectedKeys = Object.keys(tool.project({}));
    for (const ref of tool.relatedRecordRefs ?? []) {
      expect(
        projectedKeys,
        `${tool.id} declares related ref "${ref.field}" which its projection does not emit`,
      ).toContain(ref.field);
      expect(DIAGNOSTICS_CONSENT_RECORD_KINDS).toContain(ref.kind);
      // A related ref that names the entry's OWN record is a no-op at best and a
      // self-referential derivation at worst.
      expect(ref.field).not.toBe(tool.consentRecordArgKey);
    }
  });

  it("refuses, at definition time, an entry with no way to be gated", () => {
    const base = {
      id: "diagnostics.consent_fixture",
      label: "Consent fixture",
      description:
        "Test-only entry used to pin the definition-time consent declaration invariant.",
      requiredAreas: ["support"] as const,
      source: "select_only_sql" as const,
      argsSchema: z.object({ bookingId: z.string() }).strict(),
      inputSchema: {
        type: "object" as const,
        properties: { bookingId: { type: "string" } },
        additionalProperties: false as const,
      },
      sql: "SELECT true AS ok",
      bind: () => [],
      project: (row: Record<string, unknown>) => ({ ok: row.ok === true }),
      rowLimit: 1,
      byteLimit: 64,
    };

    // Surfaces personal data, names no record, is not a search: ungateable.
    expect(() =>
      defineDiagnosticsTool({ ...base, surfacesPersonalData: true }),
    ).toThrow(/names neither the record it is about/);

    // Half a record declaration.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: true,
        consentRecordKind: "booking",
      }),
    ).toThrow(/travel together/);

    // Both gates at once — a contradiction about which one governs it.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: true,
        operatorOnly: true,
        consentRecordKind: "booking",
        consentRecordArgKey: "bookingId",
      }),
    ).toThrow(/one or the other/);

    // Related refs with no record to derive FROM.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: false,
        relatedRecordRefs: [{ field: "ownerMemberRef", kind: "member" }],
      }),
    ).toThrow(/nothing for the consent ledger to derive FROM/);

    // An empty declaration, which reads as "considered and none" but declares nothing.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: true,
        consentRecordKind: "booking",
        consentRecordArgKey: "bookingId",
        relatedRecordRefs: [],
      }),
    ).toThrow(/Omit it rather than declaring nothing/);

    // Related refs on an entry nobody reviewed as a consent surface (#2785 review).
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: false,
        consentRecordKind: "booking",
        consentRecordArgKey: "bookingId",
        relatedRecordRefs: [{ field: "ownerMemberRef", kind: "member" }],
      }),
    ).toThrow(/only an entry reviewed as a consent surface/);

    // Two answers to "what kind of record is this about".
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: false,
        consentRecordKind: "booking",
        consentRecordArgKey: "bookingId",
        consentRecordKindByArg: {
          argKey: "subject",
          kinds: { booking: "booking" },
        },
      }),
    ).toThrow(/exactly one way/);

    // A per-argument kind map that does not cover the argument's own enum. This is
    // the clause that makes adding a subject to a schema a decision rather than an
    // omission: the registry refuses to build until somebody says which kind it is.
    const withSubject = {
      ...base,
      argsSchema: z
        .object({ subject: z.enum(["booking", "invoice"]), recordId: z.string() })
        .strict(),
      inputSchema: {
        type: "object" as const,
        properties: {
          subject: { type: "string", enum: ["booking", "invoice"] },
          recordId: { type: "string" },
        },
        additionalProperties: false as const,
      },
      surfacesPersonalData: false,
      consentRecordArgKey: "recordId",
    };
    expect(() =>
      defineDiagnosticsTool({
        ...withSubject,
        consentRecordKindByArg: {
          argKey: "subject",
          kinds: { booking: "booking" },
        },
      }),
    ).toThrow(/unmapped: invoice/);
    expect(() =>
      defineDiagnosticsTool({
        ...withSubject,
        consentRecordKindByArg: {
          argKey: "subject",
          kinds: { booking: "booking", invoice: null, ghost: null },
        },
      }),
    ).toThrow(/mapped but not accepted: ghost/);
    // A discriminant with no closed enum cannot be mapped exhaustively at all.
    expect(() =>
      defineDiagnosticsTool({
        ...withSubject,
        consentRecordKindByArg: {
          argKey: "recordId",
          kinds: { booking: "booking" },
        },
      }),
    ).toThrow(/no closed string enum/);
    // And the exhaustive one defines, including its deliberate `null`.
    expect(() =>
      defineDiagnosticsTool({
        ...withSubject,
        consentRecordKindByArg: {
          argKey: "subject",
          kinds: { booking: "booking", invoice: null },
        },
      }),
    ).not.toThrow();

    // The well-formed shapes still define.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: true,
        consentRecordKind: "booking",
        consentRecordArgKey: "bookingId",
      }),
    ).not.toThrow();
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        surfacesPersonalData: true,
        operatorOnly: true,
      }),
    ).not.toThrow();
    expect(() =>
      defineDiagnosticsTool({ ...base, surfacesPersonalData: false }),
    ).not.toThrow();
  });

  it("refuses, at definition time, a per-record entry that answers nothing (#2785 delta review)", () => {
    // THE HOLE THIS CLOSES. The definition-time invariant above only reaches entries
    // that declare `surfacesPersonalData`. The five per-record entries that return
    // codes, amounts and instants declared it false, named no record, and so sat
    // outside gate 4b entirely until the fix lane bound them BY HAND — which binds the
    // entries that exist, not the next one. `booking_hold_state({ bookingId })`,
    // projecting nothing but status codes, would have defined cleanly, been offered on
    // every request, and been readable for any booking id the model could name. The
    // registry census cannot catch that either: it filters on entries that DECLARE a
    // record, so an entry that never had a declaration never enters the comparison.
    //
    // So the signal is the ARGUMENT SCHEMA, which no author can forget to write: a
    // REQUIRED argument that accepts an exact identifier and refuses free text.
    const perRecordShape = {
      id: "diagnostics.record_scope_fixture",
      label: "Record scope fixture",
      description:
        "Test-only entry used to pin the definition-time record-scope invariant.",
      requiredAreas: ["support"] as const,
      source: "select_only_sql" as const,
      argsSchema: z
        .object({ bookingId: z.string().min(20).max(40).regex(/^[a-z0-9]+$/) })
        .strict(),
      inputSchema: {
        type: "object" as const,
        properties: { bookingId: { type: "string" } },
        required: ["bookingId"],
        additionalProperties: false as const,
      },
      sql: "SELECT true AS ok",
      bind: () => [],
      project: (row: Record<string, unknown>) => ({ ok: row.ok === true }),
      rowLimit: 1,
      byteLimit: 64,
      surfacesPersonalData: false,
    };

    expect(() => defineDiagnosticsTool({ ...perRecordShape })).toThrow(
      /asked about one identified thing/,
    );

    // The three ways to answer, all of which define.
    expect(() =>
      defineDiagnosticsTool({
        ...perRecordShape,
        consentRecordKind: "booking",
        consentRecordArgKey: "bookingId",
      }),
    ).not.toThrow();
    expect(() =>
      defineDiagnosticsTool({ ...perRecordShape, operatorOnly: true }),
    ).not.toThrow();
    expect(() =>
      defineDiagnosticsTool({
        ...perRecordShape,
        consentRecordExemption:
          "The id names a provider event, not a platform record an operator can select.",
      }),
    ).not.toThrow();

    // An OPTIONAL identifier is not what the entry is about — the audit-correlation
    // entries read a window of events and filter inside it — so it does not trip.
    expect(() =>
      defineDiagnosticsTool({
        ...perRecordShape,
        argsSchema: z
          .object({
            window: z.enum(["1h", "24h"]),
            requestId: z
              .string()
              .min(20)
              .max(40)
              .regex(/^[a-z0-9]+$/)
              .optional(),
          })
          .strict(),
      }),
    ).not.toThrow();

    // And an entry whose schema cannot be introspected at all fails CLOSED, because a
    // detector that silently stops detecting is this assert's own failure mode.
    expect(() =>
      defineDiagnosticsTool({
        ...perRecordShape,
        argsSchema: z.union([
          z.object({ bookingId: z.string() }).strict(),
          z.object({ paymentId: z.string() }).strict(),
        ]),
      }),
    ).toThrow(/not a plain object/);
  });

  it("refuses an exemption that excuses nothing (#2785 delta review)", () => {
    const base = {
      id: "diagnostics.exemption_fixture",
      label: "Exemption fixture",
      description:
        "Test-only entry used to pin the consent-record exemption invariant.",
      requiredAreas: ["support"] as const,
      source: "select_only_sql" as const,
      argsSchema: z
        .object({ eventRef: z.string().min(20).max(40).regex(/^[a-z0-9]+$/) })
        .strict(),
      inputSchema: {
        type: "object" as const,
        properties: { eventRef: { type: "string" } },
        required: ["eventRef"],
        additionalProperties: false as const,
      },
      sql: "SELECT true AS ok",
      bind: () => [],
      project: (row: Record<string, unknown>) => ({ ok: row.ok === true }),
      rowLimit: 1,
      byteLimit: 64,
      surfacesPersonalData: false,
      consentRecordExemption: "A provider event reference, not a platform record.",
    };

    // A blank reason is not a review.
    expect(() =>
      defineDiagnosticsTool({ ...base, consentRecordExemption: "   " }),
    ).toThrow(/empty consentRecordExemption/);

    // An exemption beside a real consent declaration: one of the two is stale.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        consentRecordKind: "booking",
        consentRecordArgKey: "eventRef",
      }),
    ).toThrow(/BOTH a consent record and a consentRecordExemption/);

    // A search is governed by the channel gate, so there is nothing to excuse.
    expect(() =>
      defineDiagnosticsTool({ ...base, operatorOnly: true }),
    ).toThrow(/nothing for the exemption to excuse/);

    // And an exemption on an entry that takes no identifier at all is a declaration
    // that stopped being true — the argument was removed and the excuse was left.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        argsSchema: z.object({ window: z.enum(["1h", "24h"]) }).strict(),
      }),
    ).toThrow(/exempt from nothing/);
  });
});

describe("read-only seam declarations (#2786)", () => {
  /**
   * A `server_owned` fixture that is complete APART from the declaration under
   * test, so each expectation below fails for exactly one reason.
   */
  const base = {
    id: "diagnostics.seam_fixture",
    label: "Seam fixture",
    description:
      "Test-only entry used to pin the definition-time read-only seam invariant.",
    requiredAreas: ["support"] as const,
    source: "server_owned" as const,
    argsSchema: z.object({}).strict(),
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false as const,
    },
    readEvidence: async () => [],
    project: (row: Record<string, unknown>) => ({ ok: row.ok === true }),
    rowLimit: 1,
    byteLimit: 64,
    surfacesPersonalData: false,
  };

  it("registers EVERY server-owned entry with a declaration that holds up", () => {
    // The census half. The two tests below prove the assert refuses a bad
    // declaration; this proves it was actually APPLIED to the real registry, which
    // is the property that would silently lapse if a future entry were built by
    // some path that skipped `defineDiagnosticsTool`.
    const serverOwned = DIAGNOSTICS_TOOLS.filter(
      (tool) => tool.source === "server_owned",
    );
    expect(serverOwned.length).toBeGreaterThan(0);

    for (const tool of serverOwned) {
      const declaration = tool.readOnlySeam;
      expect(declaration, `${tool.id} carries no readOnlySeam`).toBeDefined();
      expect(typeof declaration.threadsOwnReads, tool.id).toBe("boolean");
      // Says something: threads its own reads, or names what it reads through.
      expect(
        declaration.threadsOwnReads || (declaration.exemptions?.length ?? 0) > 0,
        `${tool.id} declares neither threaded reads nor an exemption`,
      ).toBe(true);
      for (const id of declaration.exemptions ?? []) {
        expect(
          READ_ONLY_SEAM_EXEMPTION_IDS,
          `${tool.id} names undeclared exemption "${id}"`,
        ).toContain(id);
      }
    }
  });

  it("refuses, at definition time, a declaration that cannot be true", () => {
    // Reaches its evidence in some third way nobody has reviewed.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: { threadsOwnReads: false },
      }),
    ).toThrow(/names no exemption/);

    // An id that is not in the table. This is the clause that keeps the table
    // CLOSED: without it, a typo or a deleted row leaves a declaration that still
    // reads as a reviewed decision while pointing at nothing.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: {
          threadsOwnReads: false,
          exemptions: ["readiness-own-pools"],
        },
      }),
    ).toThrow(/not in READ_ONLY_SEAM_EXEMPTIONS/);

    // "Declared nothing" and "declared an empty list" must not read alike.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: { threadsOwnReads: true, exemptions: [] },
      }),
    ).toThrow(/Omit it rather than declaring nothing/);

    // One reliance, stated once.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: {
          threadsOwnReads: false,
          exemptions: ["cron-runs-own-budget", "cron-runs-own-budget"],
        },
      }),
    ).toThrow(/more than once/);
  });

  it("accepts each of the three shapes an honest entry can have", () => {
    // Threads everything.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: { threadsOwnReads: true },
      }),
    ).not.toThrow();

    // Threads nothing, and says what it reads through instead.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: {
          threadsOwnReads: false,
          exemptions: ["deployment-no-database"],
        },
      }),
    ).not.toThrow();

    // Both — the usage-health shape, which is the one an "either/or" rule would
    // have forced into a lie.
    expect(() =>
      defineDiagnosticsTool({
        ...base,
        readOnlySeam: {
          threadsOwnReads: true,
          exemptions: ["usage-summary-no-tx-client"],
        },
      }),
    ).not.toThrow();
  });

  it("asks nothing of a SELECT-only entry, which PostgreSQL already bounds", () => {
    // The seam exists because a server-owned entry runs on the application's
    // full-privilege connection. A `select_only_sql` entry runs as the read-only
    // role on its own pool inside `BEGIN READ ONLY`, so requiring a declaration
    // from it would be ceremony that teaches nothing.
    expect(() =>
      defineDiagnosticsTool({
        id: "diagnostics.seam_fixture_sql",
        label: "Seam fixture (SQL)",
        description:
          "Test-only entry pinning that the seam declaration is a server-owned concern.",
        requiredAreas: ["support"],
        source: "select_only_sql",
        argsSchema: z.object({}).strict(),
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        sql: "SELECT true AS ok",
        bind: () => [],
        project: (row: Record<string, unknown>) => ({ ok: row.ok === true }),
        rowLimit: 1,
        byteLimit: 64,
        surfacesPersonalData: false,
      }),
    ).not.toThrow();
  });
});

describe("the substrate readiness probe (#2374)", () => {
  const registered = findDiagnosticsTool(DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID);
  const probe =
    registered?.source === "select_only_sql" ? registered : undefined;

  it("is registered under support:view and surfaces no personal data", () => {
    expect(probe).toBeDefined();
    expect(probe?.requiredAreas).toEqual(["support"]);
    expect(probe?.surfacesPersonalData).toBe(false);
  });

  it("reads no relation at all — AID-5 carries no domain tool", () => {
    // The property that matters is "names no table or view", NOT "contains no
    // `FROM`": the probe legitimately uses `EXTRACT(epoch FROM …)`, and banning the
    // keyword outright asserted the wrong thing (it failed the moment the timeout
    // was reported numerically). So assert there is no FROM-clause relation
    // reference and no JOIN, and that every function called is `pg_catalog`-
    // qualified — which is what actually makes the probe safe before any grant.
    const sql = probe?.sql ?? "";
    // A relation reference is `FROM <name>`; `FROM <expr>)` inside EXTRACT is not.
    expect(sql).not.toMatch(/\bfrom\s+(?:only\s+)?[A-Za-z_"][\w".]*\s*(?:,|$|\s)/im);
    expect(sql).not.toMatch(/\bjoin\b/i);
    expect(sql).not.toMatch(/\bpublic\./i);
    expect(sql).toContain(
      "pg_catalog.current_setting('transaction_read_only')",
    );
  });

  it("takes no arguments and binds no parameters", () => {
    const binding = probe?.parseArgs({});
    expect(binding?.ok).toBe(true);
    if (binding?.ok && binding.source === "select_only_sql") {
      expect(binding.params).toEqual([]);
    }
  });

  it("projects only the flat scalars it declares, dropping any other column", () => {
    const row = probe?.project({
      probe_ok: true,
      transaction_read_only: "on",
      // PostgreSQL's own rendering: a GUC set in ms reads back in the largest unit
      // that divides evenly, so the raw setting is `5s`, not `5000ms`.
      statement_timeout: "5s",
      statement_timeout_ms: 5000,
      // A column the projection must drop even though the query returned it.
      leaked_secret: "should not survive",
    });
    expect(row).toEqual({
      probeOk: true,
      transactionReadOnly: "on",
      statementTimeout: "5s",
      statementTimeoutMs: 5000,
    });
  });

  it("projects the timeout as a NUMBER so a dropped timeout cannot pass as a string", () => {
    // The reason the numeric field exists: `statement_timeout = 0` means no timeout
    // at all, and a string comparison against a formatted value let that through.
    const row = probe?.project({
      probe_ok: true,
      transaction_read_only: "off",
      statement_timeout: "0",
      statement_timeout_ms: 0,
    });
    expect(row?.statementTimeoutMs).toBe(0);
    expect(typeof row?.statementTimeoutMs).toBe("number");
  });

  it("projects a finite number even when the database returns nothing for it", () => {
    // `boundedScalar` refuses a non-finite number, so a missing column must not
    // become NaN and turn a healthy probe into `redaction_failed`.
    const row = probe?.project({ probe_ok: true });
    expect(Number.isFinite(row?.statementTimeoutMs)).toBe(true);
    expect(row?.statementTimeout).toBe("");
  });
});

describe("the evidence modules are SERVER-ONLY (#2375)", () => {
  /**
   * Which modules in the tool tree may never reach a browser bundle. These are the
   * ones that open a connection, decide authorization, write an audit row, or export
   * a function that READS evidence.
   *
   * Why this is a test and not a convention. `define.ts` used to claim that a
   * server-owned registry entry made its evidence source "unreachable". It does not:
   * the entry exposes no handle (pinned separately, `"readEvidence" in tool` is
   * false), but the four sources in `packs/support-evidence.ts` are ordinary module
   * exports, and three of them query application tables on the application's own
   * full-privilege connection with the registry projection as their only boundary.
   * The docblocks now say so plainly, and they rest on this marker: a future caller
   * can still import a reader server-side, but it can never be bundled for a
   * browser, and the marker is what makes that a guarantee rather than a habit.
   */
  const SERVER_ONLY_MODULES = [
    "audit.ts",
    "authorize.ts",
    "database.ts",
    "invoke.ts",
    "packs/booking-evidence.ts",
    "packs/booking-records.ts",
    "packs/booking-search.ts",
    "packs/booking-shared.ts",
    "packs/booking-state.ts",
    "packs/membership-records.ts",
    "packs/finance-evidence.ts",
    "packs/finance-records.ts",
    "packs/finance-search.ts",
    "packs/finance-shared.ts",
    "packs/finance-state.ts",
    "packs/support-correlation.ts",
    "packs/support-evidence.ts",
    "packs/support-system.ts",
    // The shared read-only seam (#2786). It holds the application's Prisma client
    // and opens the transaction every server-owned evidence read runs inside, so
    // it belongs on this list for exactly the reason `database.ts` does.
    "read-only-transaction.ts",
  ] as const;

  it.each(SERVER_ONLY_MODULES)("%s imports server-only", (relativePath) => {
    const source = readFileSync(
      join(import.meta.dirname, "..", relativePath),
      "utf8",
    );
    expect(source).toContain('import "server-only";');
  });

  it("covers every pack module, so a new pack cannot skip the marker", () => {
    // Census, not a list: AID-6B and AID-6C add pack modules, and a pack that
    // forgets the marker must fail here rather than at a reviewer's discretion.
    const packDir = join(import.meta.dirname, "..", "packs");
    const packModules = readdirSync(packDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `packs/${name}`)
      .sort();
    expect(packModules).toEqual(
      SERVER_ONLY_MODULES.filter((name) => name.startsWith("packs/")).slice().sort(),
    );
  });
});
