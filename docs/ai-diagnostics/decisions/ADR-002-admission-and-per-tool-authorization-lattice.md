# ADR-002: Admission and Per-Tool Authorization Lattice

## Status

Accepted — 2 August 2026. Foundation decision for epic #2369 (AI Diagnostics).
The owner ratified the admission-breadth default in §1 on issue #2370: any admin
account (finance-only accounts included) may open the Diagnostics shell, because
the shell carries no data and every tool still freshly re-checks its own
`area:view` at call time.

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo.

## Context

The platform's admin authorization is a per-area lattice
(`src/lib/admin-permissions.ts`): seven areas — `overview`, `bookings`,
`membership`, `finance`, `lodge`, `content`, `support` — each held at `none`,
`view`, or `edit`. A route's requirement is resolved from its path and HTTP
method (`getAdminRouteRequirement`, lines 597-624: read methods need `view`,
write methods need `edit`), and a member's effective matrix is read fresh from
the database-joined access-role definitions, never widened from a stale JWT
(`getAdminPermissionMatrix`, lines 515-546; the `/api/help/chat` route already
re-reads roles from the DB for its surface downgrade,
`resolveEffectiveSurface`, `src/app/api/help/chat/route.ts:88-104`).

Diagnostics is admin-only, but "admin" is not one privilege — a bookings editor,
a treasurer, and a content editor hold very different slices of the lattice. A
single tool (for example "read this booking's payment ledger") reads data that,
in the admin UI, is gated by a specific area at `view`. Diagnostics must not let
the model, the shell, or a broadly-scoped admin read data their own lattice slice
would deny them in the UI.

## Decision

### 1. Admission: an explicit any-admin rule that grants only the shell

Any account that holds **`view` or better on at least one admin permission
area** may open the Diagnostics shell. Admission is checked with an explicit,
named admission predicate (an AID-2 helper), not by reusing an unrelated guard.

Admission grants **only** the shell: the ability to open Diagnostics, read its
own help text, and *attempt* a question. It grants **no evidence whatsoever**.
No tool result, page-context field, or knowledge excerpt is returned on the
strength of admission alone.

> **Owner-ratified (2 August 2026, #2370): admission counts *all seven* areas,
> `finance` included** — a treasurer holding only `finance:view` may open the
> shell, because the shell exposes nothing and their finance-scoped tools still
> gate independently. This is deliberately *wider* than `hasAdminPortalAccess`
> (`admin-permissions.ts:556-561`), which excludes a finance-only account from
> the *admin portal*; the shell is not the admin portal and carries no data.
> Narrowing admission later (to exclude finance-only accounts) remains possible
> without affecting any tool's own gate, but requires a fresh owner decision.

### 2. Every tool freshly re-checks its own `area:view` at call time

Each Diagnostics tool declares, in the capability registry (AID-2 #2371), the
**exact admin permission requirement** that governs the same data in the admin
UI — always at `view` (a tool can never require or perform `edit`; Diagnostics
is read-only, ADR-001).

At the moment a tool is invoked — on **every** invocation, not once per session —
the substrate:

1. re-reads the caller's effective permission matrix **from the database-joined
   access roles** (never from the JWT/session snapshot), exactly as
   `resolveEffectiveSurface` does today;
2. evaluates the tool's requirement with `hasAdminAreaAccess`
   (`admin-permissions.ts:563-571`);
3. runs the tool only if the check passes; otherwise it **fails closed** — the
   tool returns an authorization-denied result, the denial is audited (ADR-004),
   and no evidence is produced.

A fresh per-call re-check (rather than a cached admission grant) means a role
revoked mid-session takes effect on the next tool call, and a multi-tool loop
(ADR-005) cannot escalate: round two is authorized exactly as strictly as round
one.

### 3. Cross-area tools require every area they read (AND, never OR)

A tool that reads data governed by more than one area (for example a booking that
also surfaces a payment) requires **`view` on every** contributing area — a
conjunction, evaluated fail-closed. A tool is never admitted on the *union* of
areas. Where a single coherent question would need two areas the caller only
half-holds, the correct outcome is a partial, permission-scoped answer plus an
explicit "you do not have finance access, so payment detail is omitted", not a
widened read.

### 4. The permission matrix for the planned tool packs

The capability registry is the authoritative, machine-checkable matrix; this
table is the contract the registry must satisfy. Each planned tool pack maps to
the area that already governs its data in the admin route lattice
(`ROUTE_AREA_PREFIXES`, `admin-permissions.ts:133-368`):

| Tool pack / child | Evidence it reads | Required (fresh) permission |
| --- | --- | --- |
| Config & readiness, sanitized correlation (AID-6A, #2375) | module flags, readiness/health, sanitized audit/error correlation | `support:view` |
| Booking search, booking summary/link/party/request/audit evidence, per-night capacity (AID-6B, #2376) | bookings, party and stay ranges, change and policy-exception requests, booking audit history, the authoritative capacity calculation | `bookings:view` |
| Booking bed-allocation and double-bed-sharing state (AID-6B, #2376) | the selected booking's allocations plus the live membership and confirmed partner-link facts for both occupants | `bookings:view` **and** `membership:view` |
| Member search, per-member evidence, member eligibility (AID-6B, #2376) | members, subscription rows by season, family-group and parent/dependent links, membership audit history, the authoritative eligibility calculation | `membership:view` |
| A member's booking involvement (AID-6B, #2376) | which member, joined to the bookings they own or are a guest on | `membership:view` **and** `bookings:view` |
| Authoritative booking block state (AID-6B, #2376) | the booking's status, nights, capacity, review and exception state combined with the membership facts the hosting and paid-up-adult rules read | `bookings:view` **and** `membership:view` |
| Finance & Xero-linkage tools (AID-6C, #2377) | payments, attempts, refunds, webhook receipts, Xero invoice linkage, finance audit history | `finance:view` |
| Member↔Xero contact linkage (AID-6C, #2377) | a member's Xero contact link and its sync operations | `finance:view` **and** `membership:view` |
| Authoritative booking-finance state (AID-6C, #2377) | the booking's own price and status combined with its payment, credit and refund position | `finance:view` **and** `bookings:view` |
| (any lodge-operations tool, if added) | hut leaders, rosters, chores, rooms/beds, lodge settings | `lodge:view` |
| (any content tool, if added) | page content, banners, site chrome | `content:view` |

**AID-6B permission split: 7 booking-only, 6 membership-only, 3 combined.**
`booking_bed_allocation_state` is combined: it requires `bookings:view` and
`membership:view`. The second area is required because its double-bed verdict reads
live membership and partner-link facts for both occupants, including an occupant
from another booking.

The deployed-knowledge bundle (#2372) and typed page context (#2373) are
evidence *classes* (ADR-003), not domain tools; the knowledge bundle is deployed
public artifact and is readable by any admitted admin, while page context is
scoped to the page the admin is actually on. A tool that ever needs `edit` does
not belong in Diagnostics.

## Consequences

### Positive

- Diagnostics cannot read past the caller's own admin-UI authority; the model and
  the shell are strictly less privileged than, and never more than, the operator.
- Re-checking every call closes mid-session escalation and honours mid-session
  revocation.
- Reusing the existing area lattice means no parallel, drift-prone permission
  model is invented; a reviewer can map each tool to a known area/route.

### Negative

- Every tool call pays a fresh DB role read (bounded, cacheable within a single
  request; the cost is the security property).
- A cross-area question yields a partial answer for a half-privileged admin,
  which must be explained clearly in the UI rather than silently widened.

## Related

- ADR-001 (separate, read-only product)
- ADR-003 (untrusted evidence classes)
- ADR-005 (fail-closed control plane; bounded tool loop)
- ADR-007 (SELECT-only DB credential; the substrate that runs the gated tools)
- ADR-008 (evidence can steer the *answer* even when it cannot authorize a tool;
  the output channel closes that in-scope path)
- [Threat model](../threat-model.md) — see the "Elevation of privilege" and
  "authorization" rows.
