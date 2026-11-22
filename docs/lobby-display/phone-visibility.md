# Member phone-number visibility (opt-in)

Fork feature hoppers99/AlpineClubBookingsNZ#37. This documents the resulting behaviour after the feature
landed (children hoppers99/AlpineClubBookingsNZ#124 schema, hoppers99/AlpineClubBookingsNZ#125 enforcement, hoppers99/AlpineClubBookingsNZ#126 UI, hoppers99/AlpineClubBookingsNZ#127 this doc), so an
operator or reviewer can reason about exactly when a member's phone number is
shown and where.

## The model in one sentence

A member's phone number appears on the **public lobby display** only when
**the lodge has enabled phone display** *and* **the member has opted in** *and*
**the member is an adult** — while the **authenticated staff check-in kiosk**
keeps showing adult contact numbers for the leader-contact use case, regardless
of the opt-in.

## The two surfaces

| Surface | Who sees it | Phone rule |
| --- | --- | --- |
| **Public lobby display** (the wall screen) | Anyone in the lobby | Shown only under the full two-sided gate below. Off by default. |
| **Staff check-in kiosk** (`/lodge/kiosk`) | Authenticated staff / hut-leaders (not staying-guests) | Adult contact numbers shown for the check-in contact use case. **Exempt** from the opt-in gate (owner decision on AC5). |

The staying-guest self-service view never shows any contact number on either
surface.

## The two-sided consent gate (public display)

All three must be true for a number to reach the public wall:

1. **Lodge config** — `Lodge.showGuestPhonesOnScreens` is on. Set per lodge by a
   full admin on **Lodges → (lodge) → Lobby display → "Show guest phone numbers
   on the lobby display"**. Default **off**.
2. **Member opt-in** — `Member.lodgeScreenPhoneOptIn` is on. Set by the member
   on **Profile → Personal Details → "Show my phone number on the lodge lobby
   display"**. Default **off**, and the control is shown to **adults only**.
3. **Adult** — the member's age tier is `ADULT`. A non-adult number is never
   released, regardless of the two settings. On the display a booking that
   contains a minor collapses to a family label, so no per-guest row (and hence
   no number) is produced for it at all.

Because both flags default off, the default state of every install is **no phone
on the public display**.

## Where it is enforced

Enforcement lives **only** in the serving serialisers, never in a template or
client component — no surface can display a number the API did not serve
(hoppers99/AlpineClubBookingsNZ#37 AC4). The single decision point is
[`canServeMemberPhoneOnLodgeSurface`](../../src/lib/phone.ts):

- **Public wall** — [`src/lib/lodge-display-state.ts`](../../src/lib/lodge-display-state.ts)
  releases `DisplayStateGuest.phone` per guest only when the full gate passes on
  a row that already shows individual names.
- **Staff kiosk** — [`src/app/api/lodge/guests/[date]/route.ts`](../../src/app/api/lodge/guests/%5Bdate%5D/route.ts)
  keeps its prior behaviour (adults-only, non-staying-guest tier) and is
  deliberately **not** wired to the opt-in gate.

## Revocation

The display payload is rebuilt on every refresh, so when a member turns their
opt-in off (or an admin turns the lodge config off) the number stops appearing
on the public wall within one refresh interval (hoppers99/AlpineClubBookingsNZ#37 AC3). No number is cached.

## No-regression guarantee (AC5)

The hut-leader / kiosk contact view is unchanged by this feature: it still shows
an adult member's phone to staff without requiring any opt-in. This is pinned by
a regression test in
[`phase8-hut-leader-kiosk.test.ts`](../../src/lib/__tests__/phase8-hut-leader-kiosk.test.ts)
("serves an adult member phone to staff without requiring opt-in").

## Config transfer

`Lodge.showGuestPhonesOnScreens` is part of the config-transfer lodge-config
category (hoppers99/AlpineClubBookingsNZ#137), so it exports/imports with the rest of the lodge descriptor
between environments, alongside the other per-lodge display settings.
