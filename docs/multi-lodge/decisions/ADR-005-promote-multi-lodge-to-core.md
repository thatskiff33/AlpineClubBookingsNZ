# ADR-005: Promote multi-lodge to core (remove the `multiLodge` module flag)

**Status:** Accepted — upstream maintainer (Jordan / thatskiff33) approved in
[discussion #964](https://github.com/thatskiff33/AlpineClubBookingsNZ/discussions/964)
(2026-07-13) and delegated the work to hoppers99. Extends **ADR-002**
(core-data-model-not-a-module) from the data layer to the UI/module-flag layer.
Delivered as part of the lobby-display work (the two are intertwined — the
display's per-lodge config lives in the lodge hub). Upstream contribution; the
upstream PR is **not raised without the owner's express approval**.

**Risk:** high (admin navigation, route gating, a `ClubModuleSettings` schema
change, backward-compat for existing single-lodge installs).

## Context

The multi-lodge **data model** is already core (ADR-002) and the lodge
configuration **hub** exists (ADR-003). But a `multiLodge` **module flag** still
gates the *UI*: `src/config/feature-routes.ts` hides `/admin/lodges` (+ its API)
when the flag is off, and the sidebar filters by that. Consequences:

- Single-lodge clubs (flag off) lose the lodge hub entirely — and with it the
  only route to some lodge-scoped editors (`rooms-beds`, `lodge-settings`),
  which have no standalone sidebar entry (root cause of hoppers99/AlpineClubBookingsNZ#100, assessed in hoppers99/AlpineClubBookingsNZ#123).
- Config surfaces are split: some lodge-scoped editors sit as scattered
  standalone sidebar entries, others only under the (gated) hub.

Owner proposed unifying lodge config under the hub and letting the flag gate
only "add lodge"; the maintainer went further and approved making multi-lodge
**core** outright:

> "Yeah go ahead… switch it to be the default and it's essentially a 'start with
> one, and Add Lodge' as you need with all core code setup to work with however
> many lodges are added."

## Decision

**Remove the `multiLodge` module flag; multi-lodge is always-on core.**

- **No flag.** Remove `multiLodge` from the module registry (`src/config/modules.ts`),
  the feature-route gating (`src/config/feature-routes.ts` — lodge routes always
  available), and all code reads of `modules.multiLodge` (done in hoppers99/AlpineClubBookingsNZ#128). The
  `ClubModuleSettings.multiLodge` **column is left vestigial** (`@default(false)`,
  no longer read or set by code, though every INSERT still named it until #5396;
  see the correction under the schema decision) rather than dropped in this
  release — see the schema decision below.
- **Start with one, Add Lodge as needed.** Every install has ≥1 lodge; the "Add
  Lodge" action is always available. The UI assumes N lodges regardless of count.
- **Lodge hub is the single home for lodge config** (ADR-003): all lodge-scoped
  editors reached as Configure cards under `/admin/lodges/[id]`; the scattered
  standalone sidebar entries (Hut Fees & Seasons, Chores, Lockers, Bed
  Allocation…) are retired.
- **Single-lodge navigation:** a **one-item lodge list** (not a skip-to-lodge
  special case), with Add Lodge present. The per-page `LodgeSelect` dropdowns
  hide / auto-resolve to the single lodge when only one exists.
- **Club-scoped config** (age groups, promo codes, booking policies, membership)
  is unaffected — it stays where it is.

## Consequences

- Single-lodge clubs gain the full, structured lodge config UI; hoppers99/AlpineClubBookingsNZ#100 is resolved
  and hoppers99/AlpineClubBookingsNZ#123's unification is fully realised.
- Admin nav simplifies (one Lodges entry; no scattered lodge-config items).
- This is an **upstream** change to the multi-lodge module Jordan owns; it must
  follow upstream conventions and merge upstream (owner-approved PR only).
- One fewer module flag to reason about; the module system shrinks.

## Backward compatibility

Existing single-lodge installs currently have `multiLodge = false` and one
lodge. After the change they must transparently keep working — one lodge, full
UI, nothing hidden, no data migration of lodge content. The only schema effect
is retiring the `ClubModuleSettings.multiLodge` column; existing bookings, rooms,
seasons, etc. are already lodge-scoped (ADR-001/002) and unaffected. This is the
explicit test focus (Jordan's caveat).

## Security / safety considerations

- **Authorisation unchanged.** Ungating the lodge routes does not widen access:
  they remain admin-gated by the `(admin)` layout / `requireAdmin`, and the
  lodge-config APIs stay admin-authenticated. Removing a *feature* flag is not
  removing an *auth* gate.
- **No capacity/money/PII surface.** This is nav + routing + a config-column
  removal; it does not touch booking capacity, pricing, or member PII.
- **Schema safety — DECISION: defer the drop, leave the column vestigial.**
  A column DROP is not old-colour-compatible under blue/green: the release
  immediately prior to this change still writes `ClubModuleSettings.multiLodge`,
  so dropping it in the same release that removes the code would break old-colour
  instances mid-deploy. hoppers99/AlpineClubBookingsNZ#128 therefore keeps the column (`@default(false)`,
  now unread/unwritten — `normalizeClubModuleSettings` iterates `MODULE_KEYS`
  only, and upserts rely on the default). The physical `DROP COLUMN` is a
  **separate contract migration to run one release later**, once the
  multi-lodge-core release is deployed everywhere — tracked in
  **hoppers99/AlpineClubBookingsNZ#139** and blocked until then. This keeps the
  multi-lodge-core change expand-only.
  Correction (#5396): "upserts rely on the default" does not keep the column
  out of the SQL. Prisma sends a static `@default` in every INSERT's column
  list, so the drop is old-colour-compatible only after a release that marks
  the field `@ignore` has shipped (`INV-OPS-005`). #5396 adds that `@ignore`.
- **Backward-compat is the risk.** A single-lodge install must not regress;
  cover it explicitly in tests before any upstream PR.

## Implementation surface (see hoppers99/AlpineClubBookingsNZ#123 children)

1. Remove the flag + gating (module registry, feature-routes; lodge routes on). ✅ hoppers99/AlpineClubBookingsNZ#128
2. `ClubModuleSettings.multiLodge`: left vestigial this release
   (hoppers99/AlpineClubBookingsNZ#129); `@ignore`d by #5396; physical
   `DROP COLUMN` deferred to a later contract migration
   (hoppers99/AlpineClubBookingsNZ#139, blue/green-safe once the `@ignore` has
   shipped).
3. Sidebar/nav: single Lodges entry; one-item lodge list; Add Lodge always;
   retire scattered lodge-config entries into the hub. ✅ hoppers99/AlpineClubBookingsNZ#130 (Chores, Lockers,
   Hut Fees & Seasons retired; Bed Allocation kept as operational).
4. Lodge hub: every lodge-scoped editor as a Configure card; `LodgeSelect`
   hidden/auto for a single lodge. ✅ Satisfied by ADR-003 (the hub at
   `/admin/lodges/[id]` already hosts Rooms & Beds, Lockers, Seasons & Rates,
   Chores, Lobby display, and Capacity/Identity) and ADR-002 (`LodgeSelect`
   renders nothing and reports the sole lodge when <2 lodges exist —
   `src/components/lodge-select.tsx`, tested in `lodge-select.test.tsx`).
   Verified for hoppers99/AlpineClubBookingsNZ#131: rooms-beds (via `RoomsBedsManager`), seasons, chores,
   lockers, and bed-allocation all consume `LodgeSelect`/`useLodgeOptions`, so
   each auto-resolves to the single lodge with no picker shown.
5. Tests + backward-compat verification (single-lodge install; frozen
   route-area snapshots; module-gate tests) + docs lockstep.

> **Amendment (#1933, E7 — 2026-07-17):** Hut nightly rates were consolidated
> into a single `/admin/fees` console (Hut Fees section), alongside Joining Fees
> and Annual Membership Fees. Consequences for this ADR:
> - The lodge hub's **"Seasons & Rates"** Configure card (item 4 above) now
>   deep-links to `/admin/fees?lodgeId=<id>` (Fees → Hut Fees, lodge
>   pre-selected) instead of `/admin/seasons`. The card and the lodge-scoped
>   entry point are preserved; only its destination moved.
> - `/admin/seasons` is reduced to **season windows** (name/type/dates/active per
>   lodge) and still consumes `LodgeSelect`/`useLodgeOptions`, so item 4's
>   single-lodge auto-resolution is unchanged. Creating a season (which requires
>   at least one rate) and editing rates both happen in Fees → Hut Fees.
> - The `/admin/fees` page admits a viewer on **bookings OR finance** and gates
>   each section by its historical area (Hut Fees → bookings:edit; Joining/Annual
>   → finance:edit), so the retirement of the standalone hut-fees entry (item 3)
>   holds: hut rates remain reachable via the lodge hub card and the new console,
>   not a scattered per-lodge editor.
