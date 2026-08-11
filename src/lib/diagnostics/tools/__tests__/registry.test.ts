/**
 * The registry CONTRACT, enforced over every entry that will ever be added. These
 * assertions are the mechanical half of the "adding a tool" checklist in
 * `registry.ts`: a future tool pack (AID-6A/B/C) that ships an unbounded query, a
 * multi-statement string, a missing permission requirement, or a schema that
 * silently ignores unknown arguments fails here rather than in production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";
import { canonicalStringify, sha256Hex } from "@/lib/diagnostics/knowledge/hash";

import { readSqlPlaceholderNumbers } from "../database";
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
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

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
 * The nesting shapes a reserved key can hide in, each with a schema that ACCEPTS the
 * polluted input so the assertion is not satisfied by the schema instead of the
 * guard.
 *
 * `hashesAsIfAbsent` records what zod 4.4.3 actually does with the key, because the
 * two answers are different defects. For `__proto__` it STRIPS: the parse succeeds and
 * the accepted arguments are byte-identical to a call that never sent the key, so
 * ADR-004's durable `argsHash` cannot tell the two apart — the audit-integrity defect.
 * For `constructor` inside a `z.record(...)` it KEEPS the key (measured: the canonical
 * hashes differ), so the record would at least be faithful — but it is still an
 * argument the registry documents as a REJECTION, and the guard refuses it.
 */
interface NestedReservedKeyCase {
  label: string;
  polluted: string;
  clean: string;
  hashesAsIfAbsent: boolean;
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
  hashesAsIfAbsent: boolean,
): NestedReservedKeyCase {
  return {
    label,
    polluted,
    clean,
    hashesAsIfAbsent,
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
    true,
  ),
  nestedReservedKeyCase(
    "in a `z.record(...)`, the shape the first tool pack needs",
    z.object({ filters: z.record(z.string(), z.string()) }).strict(),
    '{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}',
    '{"filters":{"status":"open"}}',
    true,
  ),
  nestedReservedKeyCase(
    "inside an ARRAY element",
    z
      .object({ filters: z.array(z.object({ status: z.string() }).strict()) })
      .strict(),
    '{"filters":[{"__proto__":{"polluted":"yes"},"status":"open"}]}',
    '{"filters":[{"status":"open"}]}',
    true,
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
    true,
  ),
  nestedReservedKeyCase(
    "as `constructor`, which zod KEEPS rather than strips",
    z.object({ filters: z.record(z.string(), z.string()) }).strict(),
    '{"filters":{"constructor":"x","status":"open"}}',
    '{"filters":{"status":"open"}}',
    false,
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
        },
      }).length;
      const oneRow = renderToolResultEvidenceBlock({
        schemaVersion: 1, status: "ok", toolId: tool.id, label: tool.label,
        rows: [tool.project(raw)], truncated: false,
        ...(tool.evidenceScope ? { evidenceScope: tool.evidenceScope } : {}),
        observedAt: "2026-08-03T09:00:00.000Z",
        audit: { toolId: tool.id, areasChecked: [...tool.requiredAreas], authOutcome: "allowed",
          failureReason: null, argsHash: "a".repeat(64), resultHash: "b".repeat(64),
          rowCount: 1, byteCount: 0, durationMs: 1, roundIndex: 0, observedAt: "2026-08-03T09:00:00.000Z" },
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
    "refuses a reserved key %s — which zod accepts, and then cannot hash apart",
    (_label, testCase) => {
      const polluted: unknown = JSON.parse(testCase.polluted);
      const clean: unknown = JSON.parse(testCase.clean);

      // 1. Zod ACCEPTS the polluted input. This is the measurement, not a claim: if
      //    a future zod fixes the strip, this assertion is what tells us.
      const pollutedParse = testCase.parseWithSchemaOnly(polluted);
      const cleanParse = testCase.parseWithSchemaOnly(clean);
      expect(pollutedParse.success).toBe(true);
      expect(cleanParse.success).toBe(true);
      if (!pollutedParse.success || !cleanParse.success) return;

      // 2. And where it STRIPS the key it repairs the arguments silently, so the
      //    durable `argsHash` — which `invoke.ts` computes as
      //    `sha256Hex(canonicalStringify(binding.args))` — is BYTE-IDENTICAL for a call
      //    that sent the reserved key and one that did not. That is the audit-integrity
      //    defect, reproduced at depth. Asserted in BOTH directions so this stays a
      //    measurement of zod rather than a belief about it.
      const pollutedHash = sha256Hex(canonicalStringify(pollutedParse.data));
      const cleanHash = sha256Hex(canonicalStringify(cleanParse.data));
      if (testCase.hashesAsIfAbsent) {
        expect(pollutedHash).toBe(cleanHash);
      } else {
        expect(pollutedHash).not.toBe(cleanHash);
      }

      // 3. `parseArgs` is what makes the rejection total: the reserved key never
      //    reaches the schema, so there is no repaired call to hash.
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
