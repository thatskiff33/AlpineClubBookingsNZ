import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAdminRouteRequirement,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";

// ---------------------------------------------------------------------------
// Admin route -> area matrix pin (issue #1548).
//
// The sibling admin-route-map-drift.test.ts guards ONE failure mode: a new
// /api/admin route that silently lands on the `overview` catch-all. It cannot
// catch a route that is MIS-mapped onto an existing, wrong prefix (a new
// finance action added under /api/admin/members/[id]/... inherits `membership`
// and passes there).
//
// This test closes that gap by pinning the COMPLETE route -> area assignment.
// It walks every /api/admin/**/route.ts, resolves each through the REAL
// getAdminRouteRequirement(), and asserts the full map equals a frozen snapshot
// (EXPECTED_ROUTE_AREAS). Any prefix edit, new route, or reshuffle that changes
// an area shows up as a precise diff, so remapping the effective access of every
// deployed custom role cannot happen unnoticed.
//
// The snapshot is CURRENT truth, derived from the resolver over the working
// tree — not aspirational. When it fails, do NOT blindly repaste: confirm the
// new/changed route's area is the one you intend (a wrong prefix silently
// widens or narrows access), then update EXPECTED_ROUTE_AREAS to match.
// ---------------------------------------------------------------------------

const API_ADMIN_ROOT = path.join(process.cwd(), "src/app/api/admin");

function walkRouteFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkRouteFiles(entryPath);
    return entry.name === "route.ts" ? [entryPath] : [];
  });
}

// Directory segments -> URL path. Route groups "(...)" are stripped. Dynamic
// segments keep their bracketed name in the *raw* path (the human-auditable
// snapshot key) but are substituted with a concrete literal in the *resolver*
// path so prefix/pattern (e.g. [^/]+) matching behaves like a real request.
function segmentsFor(absFile: string): string[] {
  const rel = path.relative(path.join(process.cwd(), "src/app"), absFile);
  const parts = rel.split(path.sep);
  parts.pop(); // drop the route.ts leaf
  return parts.filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")));
}

function rawPathFor(absFile: string): string {
  return `/${segmentsFor(absFile).join("/")}`;
}

function resolverPathFor(absFile: string): string {
  const segments = segmentsFor(absFile).map((seg) =>
    /^\[.*\]$/.test(seg) ? "x123" : seg,
  );
  return `/${segments.join("/")}`;
}

type DiscoveredRoute = { rawPath: string; resolverPath: string };

const routes: DiscoveredRoute[] = walkRouteFiles(API_ADMIN_ROOT)
  .map((file) => ({
    rawPath: rawPathFor(file),
    resolverPath: resolverPathFor(file),
  }))
  .sort((a, b) => a.rawPath.localeCompare(b.rawPath));

// route (raw path, with [param]) -> resolved admin permission area, via the
// real resolver with a GET (area is method-independent; only level varies).
const actualAreaByRoute: Record<string, AdminPermissionArea | "__unresolved__"> =
  {};
for (const { rawPath, resolverPath } of routes) {
  const requirement = getAdminRouteRequirement(resolverPath, "GET");
  actualAreaByRoute[rawPath] = requirement?.area ?? "__unresolved__";
}

// Only route that intentionally resolves to the `overview` catch-all: the
// cross-area pending-counts aggregate that feeds the sidebar badges. Every
// other overview landing is an unmapped route and a real finding.
const OVERVIEW_ALLOWLIST = ["/api/admin/pending-counts"] as const;

// Frozen snapshot of the COMPLETE /api/admin route -> area assignment, derived
// from getAdminRouteRequirement() over the working tree. See the
// header comment: a mismatch is a real change to effective role access — verify
// intent before repasting. Several groupings are deliberate and adjudicated as
// intended (issue #1548), NOT bugs to "fix" by remapping:
//   - /api/admin/modules + /api/admin/booking-messages -> support (system
//     configuration, alongside email settings/templates and access-roles).
//   - /api/admin/committee* -> membership (committee roles/contacts are member
//     records).
//   - /api/admin/members/[id]/lodge-access -> membership (a member attribute
//     written from member admin, governed by membership:edit).
//   - /api/admin/pending-counts -> overview (the cross-area badge aggregate; the
//     only intended overview API route).
//   - member-prefix finance carve-outs (credits, xero-link/push/unlink) ->
//     finance via SPECIAL_ROUTE_AREA_PATTERNS, not membership.
const EXPECTED_ROUTE_AREAS: Record<string, AdminPermissionArea> = {
  "/api/admin/access-roles": "support",
  "/api/admin/access-roles/[id]": "support",
  "/api/admin/age-tier-settings": "bookings",
  // Alpine Central Server (ServerNZ) integration lives on the Integrations hub
  // (finance), matching the "/api/admin/alpine-server" prefix in admin-permissions.
  "/api/admin/alpine-server/other-lodges/download": "finance",
  "/api/admin/alpine-server/other-lodges/upload": "finance",
  "/api/admin/alpine-server/settings": "finance",
  "/api/admin/ai-assistant/settings": "support",
  "/api/admin/ai-assistant/usage": "support",
  // AI Diagnostics (AID-2, #2371): a separate admin-only paid capability. Its
  // budget-settings and readiness routes sit in "support" alongside the sibling
  // ai-assistant config routes above.
  //
  // The `ask` route (AID-7, #2378) inherits "support" from the same prefix, but
  // the handler OVERRIDES the inference by owner decision Q6: it passes
  // `requireAdmin({ permission: { area: "overview", level: "view" } })` — the
  // level every admin access-role grid carries, i.e. "any admitted admin" — and
  // every tool re-checks its own area at invocation. Its own route test pins
  // that call shape. This row records what the RESOLVER would say, so that if
  // someone removes the explicit override, the gate that silently springs into
  // place (`support:view`, narrowing access against Q6) is at least the one
  // adjudicated here.
  "/api/admin/ai-diagnostics/ask": "support",
  "/api/admin/ai-diagnostics/readiness": "support",
  "/api/admin/ai-diagnostics/settings": "support",
  "/api/admin/audit-log": "support",
  "/api/admin/backups/config": "support",
  // The `support` AREA, with a Full-Admin gate inside the handler — the same
  // shape the destination fields on the config route carry. Restoring over the
  // live database is not a support:edit action; the area only decides who can
  // reach the route at all.
  "/api/admin/backups/restore": "support",
  "/api/admin/backups/run": "support",
  "/api/admin/backups/status": "support",
  "/api/admin/bed-allocation": "bookings",
  "/api/admin/bed-allocation/allocations": "bookings",
  "/api/admin/bed-allocation/allocations/bulk": "bookings",
  // #2595's reviewed-move preview. `bookings` like every other allocation
  // route: it reads the board's own rows and returns an authoritative preview,
  // and the apply half stays on the plural `allocations` route above.
  "/api/admin/bed-allocation/allocations/move": "bookings",
  "/api/admin/bed-allocation/allocations/range": "bookings",
  "/api/admin/bed-allocation/allocations/removal": "bookings",
  "/api/admin/bed-allocation/approve": "bookings",
  "/api/admin/bed-allocation/auto-allocate": "bookings",
  "/api/admin/bed-allocation/beds": "bookings",
  "/api/admin/bed-allocation/beds/[id]": "bookings",
  "/api/admin/bed-allocation/rooms": "bookings",
  "/api/admin/bed-allocation/rooms/[id]": "bookings",
  "/api/admin/bed-allocation/rooms/bulk": "bookings",
  "/api/admin/bed-allocation/rooms/import-from-config": "bookings",
  "/api/admin/bed-allocation/settings": "bookings",
  "/api/admin/booking-change-requests": "bookings",
  "/api/admin/booking-change-requests/[id]": "bookings",
  // Unified officer exception-request queue (#2524): same class of officer
  // surface as booking-change-requests above, so it shares the bookings area.
  "/api/admin/booking-exception-requests": "bookings",
  // #2526: the officer's decision endpoint for one exception request. Same
  // bookings area — `view` reads it, `edit` approves or refuses it, and the
  // approval additionally reauthorizes against FRESH database roles inside its
  // own transaction (a session token can be older than a revoked role).
  "/api/admin/booking-exception-requests/[id]": "bookings",
  "/api/admin/booking-messages": "support",
  "/api/admin/booking-messages/preview": "support",
  "/api/admin/booking-messages/reset": "support",
  // #2364: booking-policy configuration gates on the bookings area, like every
  // other route in this folder — view to read it, edit to change it.
  "/api/admin/booking-policies/adult-member-hosting": "bookings",
  "/api/admin/booking-policies/cancellation": "bookings",
  "/api/admin/booking-policies/group-discount": "bookings",
  "/api/admin/booking-policies/minimum-stay": "bookings",
  "/api/admin/booking-policies/minimum-stay/[id]": "bookings",
  "/api/admin/booking-policies/periods": "bookings",
  "/api/admin/booking-policies/periods/[id]": "bookings",
  "/api/admin/booking-requests": "bookings",
  "/api/admin/booking-requests/[id]/approve": "bookings",
  "/api/admin/booking-requests/[id]/contacts": "bookings",
  "/api/admin/booking-requests/[id]/decline": "bookings",
  "/api/admin/booking-requests/[id]/hold": "bookings",
  // #2263: admin-only availability + conflict preview for a whole-lodge
  // request. Read-only and advisory, but it exposes per-night occupancy and the
  // identities of overlapping bookings, so it belongs to the same "bookings"
  // area as the approve/decline actions it informs — never a wider one.
  "/api/admin/booking-requests/[id]/hold-conflicts": "bookings",
  "/api/admin/booking-requests/[id]/link-conflicts": "bookings",
  "/api/admin/booking-requests/[id]/price": "bookings",
  "/api/admin/booking-requests/[id]/quote": "bookings",
  "/api/admin/booking-requests/[id]/release-hold": "bookings",
  "/api/admin/booking-requests/[id]/resend-attendee-confirmation": "bookings",
  "/api/admin/booking-requests/[id]/send-quote": "bookings",
  "/api/admin/booking-requests/settings": "bookings",
  "/api/admin/booking-reviews": "bookings",
  "/api/admin/bookings": "bookings",
  "/api/admin/bookings/[id]/additional-payment-reminder": "bookings",
  "/api/admin/bookings/[id]/capacity-hold": "bookings",
  "/api/admin/bookings/[id]/confirm-pending-guests": "bookings",
  "/api/admin/bookings/[id]/copy": "bookings",
  "/api/admin/bookings/[id]/eligible-family": "bookings",
  "/api/admin/bookings/[id]/exclusive-hold": "bookings",
  "/api/admin/bookings/[id]/force-confirm": "bookings",
  // B5 (#2262): a bookings-prefixed path deliberately resolved to finance by
  // SPECIAL_ROUTE_AREA_PATTERNS — recording or reversing a cash settlement is a
  // money action, gated finance:edit.
  "/api/admin/bookings/[id]/mark-paid": "finance",
  // MG4 (#2309): the officer's member-guest picker, scoped to one booking. It
  // sits in `bookings` because that is what it is FOR — adding a guest to this
  // booking — and its own handler additionally requires `membership:view`
  // before it will search by NAME (owner decision D-20, rider (a)), so the
  // area recorded here is the floor, not the whole gate.
  "/api/admin/bookings/[id]/member-guest-candidates": "bookings",
  "/api/admin/bookings/[id]/no-emails": "bookings",
  "/api/admin/bookings/[id]/requested-room": "bookings",
  // #2649: the stranded zero-dollar waitlist confirm repair. It moves booking
  // status, so path inference gives it bookings:edit, and the route declares
  // that permission explicitly rather than relying on inference.
  "/api/admin/bookings/[id]/return-to-waitlist": "bookings",
  "/api/admin/bookings/[id]/review": "bookings",
  "/api/admin/bookings/eligible-family": "bookings",
  "/api/admin/bookings/non-member-contact": "bookings",
  "/api/admin/bookings/search": "bookings",
  "/api/admin/chores": "lodge",
  "/api/admin/chores/[id]": "lodge",
  "/api/admin/club-contact": "content",
  "/api/admin/club-identity": "content",
  // CT-1 (#2989): the club-timezone maintenance API. `support` is the area — it
  // is installation configuration, alongside /api/admin/modules and
  // /api/admin/config-transfer — but the AREA is not the gate here. Both verbs
  // pass `requireAdmin({ permission: false })`, i.e. Full Admin only, the same
  // shape /api/admin/backups/restore carries. This row records what the RESOLVER
  // would say, so if that explicit override is ever removed the gate that
  // silently springs into place (`support:view` on the read, `support:edit` on
  // the write — both a WIDENING against #2989's decision) is at least the one
  // adjudicated here.
  "/api/admin/club-time-zone": "support",
  // #2998: club message board moderation. `membership`, beside the notices
  // routes -- and what each of these handlers already enforces for itself
  // via requireAdmin({ area: "membership" }).
  "/api/admin/club-posts": "membership",
  "/api/admin/club-posts/[id]": "membership",
  "/api/admin/club-posts/cleanup": "membership",
  "/api/admin/club-posts/settings": "membership",
  "/api/admin/committee/assignments": "membership",
  "/api/admin/committee/assignments/[id]": "membership",
  "/api/admin/config-transfer/apply": "support",
  "/api/admin/config-transfer/export": "support",
  "/api/admin/config-transfer/plan": "support",
  "/api/admin/config-transfer/reseal": "support",
  "/api/admin/committee/roles": "membership",
  "/api/admin/committee/roles/[id]": "membership",
  "/api/admin/communications/history": "membership",
  "/api/admin/communications/send": "membership",
  "/api/admin/notices": "membership",
  "/api/admin/notices/[id]": "membership",
  "/api/admin/notices/[id]/reads": "membership",
  "/api/admin/credit-approvals": "finance",
  "/api/admin/deletion-requests": "membership",
  "/api/admin/deletion-requests/[id]": "membership",
  "/api/admin/display/built-ins/restore": "lodge",
  "/api/admin/display/devices": "lodge",
  "/api/admin/display/devices/[id]": "lodge",
  "/api/admin/display/devices/[id]/pairing": "lodge",
  "/api/admin/display/devices/[id]/revoke": "lodge",
  "/api/admin/display/layouts": "lodge",
  "/api/admin/display/layouts/[id]": "lodge",
  "/api/admin/display/lodge-config": "lodge",
  "/api/admin/display/preview": "lodge",
  "/api/admin/display/preview-grant": "lodge",
  "/api/admin/display/reference/conditions": "lodge",
  "/api/admin/display/templates": "lodge",
  "/api/admin/display/templates/[id]": "lodge",
  "/api/admin/email-failures/[id]/reissue-token": "support",
  "/api/admin/email-failures/[id]/review": "support",
  "/api/admin/email-settings": "support",
  "/api/admin/email-suppressions": "support",
  "/api/admin/email-suppressions/[id]/clear": "support",
  "/api/admin/email-templates": "support",
  "/api/admin/email-templates/preview": "support",
  "/api/admin/email-templates/reset": "support",
  // Environment safety (ENV-SAFETY 1 #3034). `support` for route-map
  // resolution only; BOTH verbs enforce Full Admin in the route itself with
  // `requireAdmin({ permission: false })`, exactly like club-time-zone above.
  "/api/admin/environment-safety": "support",
  "/api/admin/family-groups": "membership",
  "/api/admin/family-groups/[id]": "membership",
  "/api/admin/family-groups/[id]/login-holder": "membership",
  // #2568: identity-confirmation member lookup for the family-group workflows.
  "/api/admin/family-groups/member-search": "membership",
  "/api/admin/family-groups/partner-invites": "membership",
  "/api/admin/family-groups/requests": "membership",
  "/api/admin/family-suggestions": "membership",
  "/api/admin/family-suggestions/hide": "membership",
  "/api/admin/family-suggestions/reset": "membership",
  "/api/admin/fee-configuration": "finance",
  "/api/admin/health": "support",
  "/api/admin/hut-leaders": "lodge",
  "/api/admin/hut-leaders/[id]": "lodge",
  "/api/admin/hut-leaders/[id]/pin": "lodge",
  // #2286: the custodian bed picker's per-bed availability feed.
  "/api/admin/hut-leaders/available-beds": "lodge",
  "/api/admin/hut-leaders/eligible-members": "lodge",
  "/api/admin/hut-leaders/unassigned-dates": "lodge",
  "/api/admin/image-library": "content",
  "/api/admin/image-library/[id]": "content",
  "/api/admin/image-manager/directories": "content",
  "/api/admin/image-manager/images": "content",
  "/api/admin/image-manager/upload": "content",
  "/api/admin/induction-templates": "membership",
  "/api/admin/induction-templates/[id]": "membership",
  "/api/admin/inductions": "membership",
  "/api/admin/inductions/[id]": "membership",
  // #2573: Google Analytics configuration. `finance`, deliberately and like every
  // other route on this prefix — Xero, Stripe and Google sign-in setup all live in
  // that area, and the owner's decision made analytics a peer of them on the same
  // Integrations hub. Read needs finance:view, write finance:edit.
  "/api/admin/integrations/analytics": "finance",
  "/api/admin/integrations/analytics/reconsent": "finance",
  "/api/admin/integrations/credentials": "finance",
  "/api/admin/integrations/google/status": "finance",
  "/api/admin/integrations/google/verify/start": "finance",
  "/api/admin/integrations/stripe/status": "finance",
  "/api/admin/integrations/wizard-progress": "finance",
  "/api/admin/internet-banking-settings": "finance",
  "/api/admin/issue-reports": "support",
  "/api/admin/issue-reports/[id]": "support",
  "/api/admin/lockers": "membership",
  "/api/admin/lockers/[id]": "membership",
  "/api/admin/lockers/bulk": "membership",
  "/api/admin/lodge": "lodge",
  "/api/admin/lodge-instructions": "lodge",
  "/api/admin/lodge-settings": "lodge",
  "/api/admin/lodges": "lodge",
  "/api/admin/lodges/[id]": "lodge",
  "/api/admin/maintenance-reports": "lodge",
  "/api/admin/maintenance-reports/[id]": "lodge",
  "/api/admin/maintenance-reports/questions": "lodge",
  "/api/admin/maintenance-reports/settings": "lodge",
  "/api/admin/maintenance-reports/tokens": "lodge",
  "/api/admin/other-lodges": "lodge",
  "/api/admin/other-lodges/[id]": "lodge",
  "/api/admin/member-applications": "membership",
  "/api/admin/member-applications/[id]": "membership",
  "/api/admin/member-applications/[id]/approval-preview": "membership",
  "/api/admin/member-applications/[id]/nominations/refresh": "membership",
  "/api/admin/member-applications/[id]/nominators/[slot]/replace": "membership",
  "/api/admin/member-fields": "membership",
  // Deliberately BOOKINGS, not membership, despite the /api/admin/member* name
  // (epic #2305, MG2 #2307): it is booking policy — ask-first vs notify-only and
  // how long a pending member guest holds the bed — so it belongs with
  // booking-requests/settings, and it is bookings editors who administer it.
  "/api/admin/member-guest-settings": "bookings",
  "/api/admin/member-lifecycle-action-requests": "membership",
  "/api/admin/member-lifecycle-action-requests/[requestId]": "membership",
  "/api/admin/members": "membership",
  "/api/admin/members/[id]": "membership",
  "/api/admin/members/[id]/audit-log": "membership",
  "/api/admin/members/[id]/credits": "finance",
  "/api/admin/members/[id]/credits/[requestId]": "finance",
  "/api/admin/members/[id]/dependent-email-source": "membership",
  "/api/admin/members/[id]/dependents/[dependentId]": "membership",
  "/api/admin/members/[id]/dependents/link": "membership",
  "/api/admin/members/[id]/family": "membership",
  // #2253: read-only derived family tree; intentionally membership like the
  // member detail page it renders inside.
  "/api/admin/members/[id]/family-tree": "membership",
  "/api/admin/members/[id]/joining-fee/preview": "membership",
  "/api/admin/members/[id]/lifecycle/archive": "membership",
  "/api/admin/members/[id]/lifecycle/delete": "membership",
  "/api/admin/members/[id]/lodge-access": "membership",
  "/api/admin/members/[id]/membership-cancellation": "membership",
  "/api/admin/members/[id]/merge": "membership",
  "/api/admin/members/[id]/merge/preview": "membership",
  "/api/admin/members/[id]/partner-link": "membership",
  "/api/admin/members/[id]/seasonal-membership": "membership",
  "/api/admin/members/[id]/seasonal-membership/preview": "membership",
  "/api/admin/members/[id]/xero-link": "finance",
  "/api/admin/members/[id]/xero-push": "finance",
  "/api/admin/members/[id]/xero-unlink": "finance",
  "/api/admin/members/bulk-membership-type": "membership",
  "/api/admin/members/bulk-membership-type/preview": "membership",
  "/api/admin/members/bulk-update": "membership",
  "/api/admin/members/export": "membership",
  "/api/admin/members/import": "membership",
  "/api/admin/members/send-password-reset": "membership",
  "/api/admin/members/send-setup-invite": "membership",
  "/api/admin/membership-cancellation-requests": "membership",
  "/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]":
    "membership",
  "/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]/resend-confirmation":
    "membership",
  "/api/admin/membership-cancellation-settings": "membership",
  "/api/admin/membership-lockout-settings": "membership",
  "/api/admin/membership-nomination-settings": "membership",
  "/api/admin/membership-types": "membership",
  "/api/admin/membership-types/[id]": "membership",
  "/api/admin/membership-types/[id]/merge": "membership",
  "/api/admin/membership-types/reorder": "membership",
  "/api/admin/membership-types/roll-forward": "membership",
  "/api/admin/modules": "support",
  "/api/admin/mountain-conditions": "content",
  "/api/admin/notification-delivery-policies": "support",
  "/api/admin/notifications": "support",
  "/api/admin/occupancy": "bookings",
  "/api/admin/page-content": "content",
  "/api/admin/public-content-settings": "content",
  "/api/admin/payments": "finance",
  "/api/admin/payments/[id]/generate-invoice": "finance",
  // B5 (#2262): the open hand-back queue and the endpoint that closes a task.
  // The /api/admin/payments prefix already resolves to finance, so no
  // SPECIAL_ROUTE_AREA_PATTERNS entry is needed for this one.
  "/api/admin/payments/manual-refund-tasks": "finance",
  "/api/admin/payments/manual-refund-tasks/[id]": "finance",
  "/api/admin/pending-counts": "overview",
  "/api/admin/promo-codes": "bookings",
  "/api/admin/promo-codes/[id]": "bookings",
  "/api/admin/promo-codes/[id]/redemptions": "bookings",
  "/api/admin/refund-requests": "finance",
  "/api/admin/refund-requests/[id]": "finance",
  "/api/admin/reports": "finance",
  "/api/admin/roster/[date]": "lodge",
  "/api/admin/roster/status": "lodge",
  "/api/admin/runtime-status": "support",
  "/api/admin/seasons": "bookings",
  "/api/admin/seasons/[id]": "bookings",
  // Login & Security config (#2033/#2103): support-area system config, pinned
  // alongside /api/admin/modules. Each route names support:edit explicitly
  // rather than relying on path inference, which depends on the middleware-set
  // request-path header (absent header ⇒ full-ADMIN fallback, silently
  // excluding support-area admins). See admin-permissions.ts.
  "/api/admin/security/magic-link": "support",
  "/api/admin/security/password-policy": "support",
  "/api/admin/setup": "support",
  "/api/admin/setup/finance-report-mappings": "finance",
  "/api/admin/setup/finance-report-mappings/backfill": "finance",
  "/api/admin/setup/progress": "support",
  "/api/admin/setup/provider-test": "support",
  "/api/admin/site-banners": "content",
  "/api/admin/site-banners/[id]": "content",
  "/api/admin/site-content": "content",
  "/api/admin/site-images": "content",
  "/api/admin/site-style": "content",
  "/api/admin/site-style/logo": "content",
  "/api/admin/stuck-states": "support",
  "/api/admin/subscriptions": "finance",
  "/api/admin/subscriptions/[id]/manual-payment": "finance",
  "/api/admin/subscription-billing": "finance",
  "/api/admin/waitlist": "bookings",
  "/api/admin/work-parties": "lodge",
  "/api/admin/work-parties/[id]": "lodge",
  "/api/admin/xero/account-mappings": "finance",
  "/api/admin/xero/callback": "finance",
  "/api/admin/xero/chart-of-accounts": "finance",
  "/api/admin/xero/connect": "finance",
  "/api/admin/xero/contact-group-mismatches": "finance",
  "/api/admin/xero/contact-groups": "finance",
  "/api/admin/xero/contact-link-mismatches": "finance",
  "/api/admin/xero/disconnect": "finance",
  "/api/admin/xero/duplicate-contacts": "finance",
  "/api/admin/xero/force-sync": "finance",
  "/api/admin/xero/health": "finance",
  "/api/admin/xero/import-member-contact": "finance",
  "/api/admin/xero/import-members": "finance",
  "/api/admin/xero/inbound-events": "finance",
  "/api/admin/xero/inbound-events/[id]/replay": "finance",
  "/api/admin/xero/item-code-mappings": "finance",
  "/api/admin/xero/items": "finance",
  "/api/admin/xero/link-maintenance": "finance",
  // E8 (#1934): member-grouping mode/rules/dry-run/bulk-resync — finance, like
  // every other /api/admin/xero surface (the route guard itself narrows the
  // POST to finance:view with per-action finance:edit checks).
  "/api/admin/xero/member-grouping": "finance",
  "/api/admin/xero/missing-invoices": "finance",
  "/api/admin/xero/operations": "finance",
  "/api/admin/xero/operations/[id]/mark-non-replayable": "finance",
  "/api/admin/xero/operations/[id]/requeue": "finance",
  "/api/admin/xero/operations/[id]/resolve": "finance",
  "/api/admin/xero/operations/[id]/retry": "finance",
  "/api/admin/xero/operations/reset-stale-running": "finance",
  "/api/admin/xero/operations/retry-all": "finance",
  "/api/admin/xero/organisation": "finance",
  "/api/admin/xero/records/[localModel]/[localId]": "finance",
  "/api/admin/xero/search-contacts": "finance",
  "/api/admin/xero/status": "finance",
  "/api/admin/xero/sync-contacts": "finance",
  "/api/admin/xero/sync-memberships": "finance",
  "/api/admin/xero/usage": "finance",
  // #2081: webhook intent-to-receive verify status / amber-badge source. Read is
  // any-admin (status visibility); the webhook-key WRITE stays Full-Admin-only
  // via the C1 credentials API. Lives under the finance area like its siblings.
  "/api/admin/xero/webhook/verify-status": "finance",
};

describe("admin route -> area matrix pin (#1548)", () => {
  it("finds the /api/admin routes to enumerate", () => {
    // Sanity floor so a broken walk can never make the pin vacuously pass.
    expect(routes.length).toBeGreaterThan(150);
  });

  it("resolves every /api/admin route to a non-null requirement", () => {
    const unresolved = Object.entries(actualAreaByRoute)
      .filter(([, area]) => area === "__unresolved__")
      .map(([rawPath]) => rawPath);
    expect(unresolved).toEqual([]);
  });

  it("never lands a route on the overview catch-all outside the allowlist", () => {
    const violations = Object.entries(actualAreaByRoute)
      .filter(
        ([rawPath, area]) =>
          area === "overview" &&
          !(OVERVIEW_ALLOWLIST as readonly string[]).includes(rawPath),
      )
      .map(([rawPath]) => rawPath);

    // overview is the resolver's catch-all: a new route landing here is almost
    // always a forgotten ROUTE_AREA_PREFIXES entry, not an intended overview
    // route. Add the mapping (or, consciously, extend OVERVIEW_ALLOWLIST).
    expect(violations).toEqual([]);
  });

  it("pins the complete route -> area assignment to the frozen snapshot", () => {
    // A mismatch is a real change to the effective access of every deployed
    // custom role. Verify the changed route's area is intended, then update
    // EXPECTED_ROUTE_AREAS.
    expect(actualAreaByRoute).toEqual(EXPECTED_ROUTE_AREAS);
  });
});

describe("admin route level derivation (#1548)", () => {
  const sample = "/api/admin/members/x123";

  it("maps GET/HEAD/OPTIONS to view and mutating methods to edit", () => {
    expect(getAdminRouteRequirement(sample, "GET")?.level).toBe("view");
    expect(getAdminRouteRequirement(sample, "HEAD")?.level).toBe("view");
    expect(getAdminRouteRequirement(sample, "OPTIONS")?.level).toBe("view");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(getAdminRouteRequirement(sample, method)?.level).toBe("edit");
    }
  });

  it("forces edit on GET for the xero connect/callback OAuth handlers", () => {
    for (const route of [
      "/api/admin/xero/connect",
      "/api/admin/xero/callback",
    ]) {
      expect(getAdminRouteRequirement(route, "GET")?.level).toBe("edit");
    }
  });
});

describe("admin member-prefix special-area carve-outs (#1548)", () => {
  it("routes member credits and xero-link/push/unlink to finance, not membership", () => {
    const financeCarveOuts = [
      "/api/admin/members/x123/credits",
      "/api/admin/members/x123/credits/y456",
      "/api/admin/members/x123/xero-link",
      "/api/admin/members/x123/xero-push",
      "/api/admin/members/x123/xero-unlink",
    ];
    for (const route of financeCarveOuts) {
      expect(getAdminRouteRequirement(route, "GET")?.area).toBe("finance");
    }

    // The carve-out is specific: the member record itself stays membership.
    expect(
      getAdminRouteRequirement("/api/admin/members/x123", "GET")?.area,
    ).toBe("membership");
  });
});
