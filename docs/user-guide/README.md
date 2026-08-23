# Member & Guest Guide

Audience: Member, Guest

Plain-English, step-by-step guides for the people who **use** the club — members
signing in to book a stay, and guests the club has invited to stay. These pages
live in the repository under `docs/user-guide/` — the source of truth — and
are automatically mirrored to the
[project wiki](https://github.com/thatskiff33/AlpineClubBookingsNZ/wiki) for
easy reading (`scripts/sync-user-guide-wiki.mjs`, run by the `Wiki sync`
workflow on every push to `main`). Propose changes by pull request; direct
wiki edits are overwritten. If you run the
club day to day, you want the [operator guides](../guides/) instead; if you are
evaluating or configuring a fork, start at the [documentation hub](../README.md).

These guides describe the **public and member-facing** side of the app (the
website, the sign-in page, your dashboard, the booking wizard, your profile) —
the routes under `/`, not the `/admin/*` console. They are the batch-5
deliverable of the documentation programme (issue #2050) and are scoped from
[`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md) and the public route tree, not the
admin-only [`COVERAGE_MATRIX.md`](../COVERAGE_MATRIX.md).

Every screen and figure here comes from the seeded demo club **Example Mountain
Club**, so your own club's name, colours, fees, and lodge capacity will differ —
the steps are the same.

> **In-app help is distilled from these guides.** The chat-style help widget
> (epic #2094) answers members in-app from a hand-distilled corpus in
> `src/lib/help/member-help.ts` (and the public corpus in `public-help.ts`), each
> entry naming the guide it came from. These short in-app answers are a
> distillation, not a copy — when you change a member guide here, review and
> update the matching entry in that corpus in the same pull request so the two
> never drift.

## How these guides are written (member-guide skeleton)

The [`STYLE_GUIDE.md`](../STYLE_GUIDE.md) defines the operator-guide skeleton
(what it is → when → step-by-step → settings → troubleshooting → related). The
member guides keep the **same spirit** with member-appropriate section names, so
every page in this folder reads the same way. Each guide uses this order:

1. **What it is** — one or two plain sentences: what this journey lets you do,
   and where you start it (the page you open or the link you click), with the
   route in `code` (e.g. `/book`).
2. **When you'd use it** — the real situations that bring a member or guest
   here.
3. **Step-by-step** — numbered actions with the exact button/field names, and a
   **screenshot** at each capturable page. Multi-step wizard screens and pop-up
   dialogs (the guests/review/pay steps, the cancellation confirm) are described
   in prose — the screenshot harness only reaches whole pages by URL, so those
   in-page steps carry no screenshot by design.
4. **What it costs / what to expect** — the member-facing equivalent of a
   settings table: what you pay (always shown in **dollars**, formatted from the
   integer cents the club stores), what the policy actually does, and the timing
   you should expect. A table where there are figures or options to compare. The
   heading is **"What it costs / what to expect"** on guides whose section covers
   money figures (the booking and paying guides), and plain **"What to expect"**
   on guides that do not.
5. **Troubleshooting** — symptom → why it happens → what you can do yourself,
   and when to contact the club office instead.
6. **Related links** — back to this index and the [documentation
   hub](../README.md), the sibling member guides, and the authoritative policy
   or reference docs that own the deeper detail.

Conventions carried through every guide, matching the domain rules in
[`DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md):

- **Audience** label under the title lists who the guide is for. `Audience:
  Member, Guest` is the default order; `Guest, Member` is used when the journey
  starts as a guest (as [Joining the club](joining-the-club.md) does, before a
  login exists).
- **Money** is always shown in dollars (e.g. `$90.00`). The club stores every
  amount in integer cents; the app formats it to dollars everywhere you see it.
- **Dates** are NZ date-only **lodge nights**. A stay from check-in to check-out
  is counted in nights, never in hours or time zones — "7 Sept — 9 Sept" is two
  nights (7th and 8th).
- **Screenshots** live under [`../images/public/`](../images/public/) and are
  captured by the shared harness (`e2e/tools/capture-screenshots.ts`) against
  the seeded demo data, never hand-cropped.

## The guides

- **[Joining the club](joining-the-club.md)** — apply for membership, get your
  two nominators to confirm, wait for committee approval, then set up your login
  and sign in for the first time.
- **[Booking a stay](booking-a-stay.md)** — the booking wizard end to end: pick
  your nights, add member and non-member guests, understand the Members First
  provisional hold versus First Paid, First In, and confirm.
- **[Paying for your stay](paying-for-your-stay.md)** — paying by card (Stripe)
  or by internet banking against a Xero invoice, split charges for non-member
  guests, and using account credit.
- **[Managing your family & household](managing-your-family.md)** — family
  groups, the billing member, adding infants/children/youth, inviting adults,
  and recording a partner.
- **[Managing your account](your-account.md)** — your profile and personal
  details, changing your email or password, two-factor authentication, the email
  sign-in link, Google sign-in, notification preferences, and your privacy /
  data-download / account-deletion rights.
- **[The waitlist & offers](waitlist-and-offers.md)** — joining the waitlist for
  a full night, opting into other lodges, and accepting an offer before it
  expires.
- **[Changing or cancelling a booking](changing-or-cancelling-a-booking.md)** —
  changing dates or guests, cancelling, and understanding whether you get a
  refund or account credit.
- **[The message board](the-message-board.md)** — writing to the club and
  reading what other members have written. Club-only for now; the share-with-
  other-clubs option is visible but not yet available.
- **[Being added to a booking by another member](being-added-to-a-booking.md)** —
  what happens when another member puts you (or your child) on their booking:
  answering the consent request, answering for a family member without a login,
  and what "told, not asked" means.

## Related links

- Back to the [documentation hub](../README.md).
- Operator (admin) guides: [`../guides/`](../guides/).
- The journey map these guides are scoped from:
  [`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md).
- Policy references: [`CANCELLATIONS.md`](../CANCELLATIONS.md),
  [`AUTHORITATIVE_FEES.md`](../AUTHORITATIVE_FEES.md),
  [`STATE_MACHINES.md`](../STATE_MACHINES.md).
