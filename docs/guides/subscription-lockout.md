# Subscription Lockout

Audience: Operator

## What it is

The page that decides whether members who have not paid their Annual Membership
Fee are blocked from booking, sets the club's financial-year window, and
configures how a paid subscription is recognised from Xero. Find it at **Admin →
Setup & Configuration → Membership & Members → Subscription Lockout**
(`/admin/subscription-lockout`); it has no direct sidebar entry — reach it through
the [Membership & Members setup hub](membership-setup.md).

**Opening this page requires *support*-area view access** — the route is
admitted under the support permission area, and an admin without it is
redirected away even though the hub card is still visible. Once inside, the
sections span three further permission areas: the lockout switch, financial
year, text-match fallback, and item-code matching mode are **membership**
settings; the Xero account/item detection codes are **finance** settings; and
the per-age-tier
requirement is a read-only view of the **bookings** age-tier settings. You only
see and can edit the sections your role covers, and **Save** only writes the
parts you can change.

## When you'd use it

- You want to start (or stop) blocking unpaid members from booking.
- Your membership subscription year differs from your Xero accounting year and you
  need to override the financial year-end month.
- Xero posts subscription invoices to a particular account or item code and you
  want the system to recognise them as "paid".

## Step-by-step

### Choose what happens when a subscription is unpaid

1. Go to **Subscription Lockout** (via **Membership & Members**). **Booking
   lockout** asks one question — what should happen when a member whose
   current-season subscription is not paid tries to book — and offers three
   answers. Pick one:

   ![Subscription lockout settings: the Booking lockout, Financial year, Paid-subscription detection, and Age tiers cards](../images/admin/admin-subscription-lockout.png)

   - **Let them book normally.** No subscription check at booking. Members book
     at member rates whether or not their subscription is paid, and the
     unpaid-subscription banner is hidden.
   - **Stop them booking.** The default, and what every club did before this
     setting existed. A member whose subscription is not paid for the season
     cannot book at all, and sees a banner asking them to pay first.
   - **Let them book, at non-member rates.** They may book, but their own nights
     are charged at the **non-member rate** until the subscription is paid.

2. Your club stays on whatever it was doing until you change this. If the lockout
   was on it keeps stopping unpaid members; if it was off it keeps letting them
   book. Nothing is repriced by upgrading.

3. If the lockout is on but Xero is not connected, a warning explains it has no
   effect (paid status can only come from Xero) and links to **Connect Xero**.
   While Xero is disconnected everyone books at member rates.

### What "non-member rates" does to a booking

This option moves money, so it is worth reading before you pick it.

- **The unpaid member's own nights** are charged at the same non-member rate any
  other non-member pays, using the same Xero item code. Their invoice reads as an
  ordinary non-member line — there is no special charge type to explain to your
  accountant.
- **Everyone else on the booking is unaffected.** Only the person whose
  subscription is unpaid is repriced.
- **They are told why**, on every screen that shows them the number: the quote
  step of the booking wizard, the edit-booking panel, and the waitlist offer email.
  The sentence explains that member rates are not available while the subscription
  is unpaid and that renewing restores them. It names nobody and no amount, so it
  is safe on a screen a family member may be reading — and it is worded about the
  booking rather than about the reader, so a paid-up member booking for an
  unfinancial relative is never told their own subscription is in arrears.
- **The invoice line says Non-member.** The hut-fee line for that member reads
  "(ADULT, Non-member)", matching the non-member amount and the non-member item
  code. If your club also uses a membership type deliberately configured onto
  non-member rates, those members' lines change the same way. It is wording only:
  no amount, item code or account code moves.
- **The booking still needs a paid-up adult member on it.** If nobody staying on
  the booking is an adult member whose subscription *is* paid, the booking is
  refused — but the member can **ask a Booking Officer to allow it**, which goes
  into the same exception-request queue as the other soft booking policies (see
  [Booking Policies](booking-policies.md)). **The bed is held while that request
  is pending**, so they are not made to race for capacity while you decide.
- **That applies to the person booking, too, even if they are not staying.** A
  member whose own subscription is unpaid cannot use this option to book beds for
  other people with no paid-up adult member among them. Without that, letting a
  subscription lapse would cost nothing so long as you booked for others — which is
  the one thing "stop them booking" reliably prevents, and it would have been
  quietly given away by choosing the softer option. It is still gentler than
  stopping them: today that member cannot book at all, and here they get the
  Booking-Officer override path with the bed held. If a paid-up adult member is on
  the booking — a financial spouse or parent, say — it simply books.
- **They cannot be given the "member of another lodge" rate while the
  subscription is owed.** If your club runs the reciprocal arrangement described
  in [Bookings → Charge a visiting club's members at your member
  rate](bookings.md#charge-a-visiting-clubs-members-at-your-member-rate), the
  tick box simply does not appear beside a member who owes a subscription, and
  the Guests card says why. This one is **not** conditional on the option you
  pick on this page — it holds even for clubs that stop unpaid members booking
  outright, and for clubs that have the lockout switched off — because the fact
  it turns on is that the subscription is owed, not what the club does about it.
  It deliberately catches the awkward case too: somebody who has let *your*
  subscription lapse while being fully paid up at the partner lodge gets no tick
  either. Otherwise anybody could lapse, name a partner lodge, and hold your
  member rate indefinitely, which is exactly the money this page exists to chase.
  Settle the subscription and the tick box appears.
- **An unpaid member stops counting as the adult member who hosts non-member
  guests.** If you also run the adult-member hosting rule, somebody the club is
  charging as a non-member is not the responsible member that rule asks for, so
  their non-member guests need a genuinely paid-up adult member present.
- **The requirement only applies where an unpaid subscription is involved.** A
  booking with nobody unpaid on it, made by a member who is paid up, is judged
  exactly as before: an all-non-member group, a family whose only member row is a
  child, and a paid-up youth member booking their own bed are all untouched.
- **It is re-checked when somebody is removed, and when a waitlist offer is
  confirmed** — not only when guests are added, and including an offer for a
  *different* lodge. Otherwise a booking could be allowed because a paid-up adult
  was on it, and that adult taken off a moment later. A member who declines a
  member-guest invite can always still be taken off a booking; that is never
  blocked. If a waitlist offer is refused for this reason the offer is **not used
  up** — the entry goes back on the waitlist at its place, so the member can fix
  the party or ask a Booking Officer instead of losing their turn.
- **Two things start being refused that go through today.** Because this
  requirement looks at the whole booking while the old subscription checks looked
  only at guests being added, confirming a draft that carries an unfinancial member
  guest, and editing a booking that already carries an unfinancial member, can now
  be refused. Both offer the Booking-Officer override and hold the bed, so they are
  reviewable rather than dead ends — but they are new refusals, and worth telling
  your Booking Officers about before you switch. The member booking for other
  people while their own subscription is unpaid is not a third case: today they
  cannot book at all.

To reverse it, pick a different answer and save. No already-taken booking is
re-priced — each guest's rate was recorded when the booking was made, and a night
somebody has already bought keeps both its price and its invoice coding even when a
later edit re-prices the rest of the stay.

### Set the financial year

1. In **Financial year**, leave **Financial year-end month** on **Follow Xero**
   unless your membership year differs from your accounting year. Choosing an
   explicit month changes how every subscription season is calculated (existing
   records are not migrated).

### Configure paid-subscription detection (finance)

1. In **Paid-subscription detection**, pick the **Subscription account code**
   (an invoice line posted to it counts as a subscription; defaults to 203 Annual
   Subs when unset) and optionally a **Subscription item code**.
2. Choose an **Item code matching** mode:
   - **Single item code** (default): only the one subscription item code above
     is matched — today's behaviour, unchanged.
   - **Use membership fee item codes (per type + age tier)**: turns on
     *look-through*. An invoice also counts when a line uses **any** item code
     from your [fee configuration](fees.md) — every membership type
     and age tier, across every season (older seasons were billed under fee rows
     you may since have retired). This is for clubs that bill one Xero item code
     per membership type + tier (e.g. "Full Member – Adult") rather than a single
     shared subscription item. The single item code above is relabelled the
     **fallback** and is *always* included in matching.
3. When look-through is on, the panel lists the resolved item codes it will
   match. If any of them **also** identifies a hut-fee, joining-fee, or promo
   line, an **overlap warning** highlights those codes — an unpaid invoice using
   a shared code could otherwise be mistaken for a paid subscription. Give
   subscriptions their own dedicated item codes to avoid false matches.
4. Tick **Match on invoice text as well** to also count invoices whose reference
   or line description reads like a subscription (a safety net that can cause
   false matches — leave off for strict code-only matching).

When several invoices in a season could match (for example a paid subscription
and an earlier unpaid invoice that shares a code), the system prefers a **paid**
invoice over an unpaid one, and a match on the account code or fallback item code
over a match on a shared fee-schedule code only — so a member who has genuinely
paid is never marked unpaid by an overlapping code, and a manual "mark paid"
stays intact.

A **voided or deleted** subscription invoice no longer counts as an outstanding
subscription. When the paid-status refresh sees a member's subscription invoice
voided/deleted in Xero, the member reads as **Not Invoiced** (not locked out)
rather than the pre-void **Unpaid** (locked out), and becomes re-billable in the
[annual billing batch](subscriptions.md#run-the-annual-billing-batch). Void an
invoice only when you intend to re-bill or clear the obligation — the member can
book again until a new invoice is raised.

### Where the non-member-rates rule came from (#2533)

The softer rule described above began as an owner decision to replace the hard
block: a subscription-locked member should still be able to book for their family,
but any individual on the booking whose subscription is not paid is charged
**non-member rates** (and told why), and the booking must include **at least one
paid-up adult member**.

It is now **in effect as the third option** of the Booking lockout setting rather
than as a change to every club: the rollout question was answered opt-in, and
**your club keeps the hard block until an admin picks the new answer**. The
requirement was then widened once, by owner decision on 3 Aug 2026, to cover the
member doing the booking as well as the members staying — see "The booking still
needs a paid-up adult member on it" above.

### Get a locked-out member into a bed: book on their behalf

**Stopping them booking does not stop them paying.** That is deliberate, it is
the design, and it is the answer to "a member owes their subscription but needs a
bed on Saturday".

Under **Stop them booking**, an unpaid member cannot start a booking of their
own. What the block has never covered — and was never meant to — is *paying for a
booking somebody else made for them*. Two different debts: the hut fee for this
stay, and the subscription for the season. Refusing to take the hut fee would not
collect a cent of the subscription; it would just cost the club a booking.

So the supported route is:

1. **You make the booking** on [Book on Behalf](book.md), choosing the member as
   the owner. The lockout does not apply to an admin booking on somebody's
   behalf, so it simply goes through.
2. **You press Save as Draft** rather than Confirm. That leaves the money for the
   member.
3. **Tell them it is waiting.** Nothing is emailed automatically about a draft.
4. **They sign in and pay it.** It is on their dashboard as a draft labelled
   "Saved for you by the club", with a **Review & pay** button, and their
   subscription banner tells them a saved booking can still be paid. Paying
   confirms the booking exactly as it would for anyone else.

Nothing about the lockout is loosened by this. The moment they try to make a
booking of their own — or to add a guest, or to edit a booking — they are refused
again, and their subscription is still owed and still chased.

Two limits are worth knowing before you rely on it:

- **Drafts are removed after 72 hours.** An unpaid draft is deleted, not
  cancelled: after three days there is nothing left to pay and the booking must
  be made again. If the member cannot pay that quickly, confirm the booking
  yourself and collect the money the usual way.
- **A $0 booking has nothing to pick up.** With nothing to pay there is no
  payment step on the member's screen, and the **Confirm** button they are
  offered instead refuses a member whose subscription is unpaid. Free bookings
  are confirmed by an admin — press **Confirm Booking** instead of **Save as
  Draft**, or confirm it from the booking's own page afterwards.

If your club is on **Let them book, at non-member rates** instead, none of this
is needed: the member books for themselves and their own nights are simply
priced at the non-member rate. Under **Let them book normally** there is no block
to work around at all.

### Review the age-tier rule

1. The **Age tiers** card shows which age tiers require a paid subscription and
   which are exempt. Click **Edit age tier settings** to change them (that is the
   [Age Groups](age-tier-settings.md) page).
2. Click **Save settings**.

## Settings reference

| Setting | Area | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- | --- |
| Enforce the booking lockout | Membership | Block unpaid members from booking | from server | No effect while Xero is disconnected |
| Financial year-end month | Membership | The subscription season window | Follow Xero (→ March) | Override changes all seasons; records not migrated |
| Match on invoice text as well | Membership | Text fallback for detecting a paid subscription | from server | Can cause false matches |
| Subscription account code | Finance | Which Xero account counts as a subscription | 203 (Annual Subs) when unset | Requires Xero connected |
| Subscription item code (optional) | Finance | A Xero item that also counts (the *fallback* code when look-through is on) | none | Requires Xero connected |
| Item code matching | Membership | Single item code, or look-through to every fee-schedule item code | Single item code | Look-through resolves codes from [fee configuration](fees.md); overlap with other fee codes is warned |
| Age-tier requirement | Bookings | Which age tiers must have a paid subscription | (read-only here) | Edit on [Age Groups](age-tier-settings.md) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The lockout is on but no one is blocked | Xero is not connected, so paid status cannot be read | Connect Xero from **Admin → Finance → Xero Setup** — see the [Xero Sync guide](xero.md) |
| The detection codes are greyed out | Xero is not connected, or you lack finance edit | Connect Xero, or ask a finance-edit admin |
| I can't see the detection or age-tier cards | Your role lacks finance/bookings access | Those sections are hidden for roles without the area; ask a full admin |
| Changing the financial year re-based my seasons | The override recalculates every season | Only override when your membership year genuinely differs from Xero's; existing records are not migrated |
| A blocked member paid for a booking — is that a bug? | No. The block stops them *starting* a booking, not paying for one an admin saved for them | This is the designed way to get a locked-out member into a bed — see "Get a locked-out member into a bed" above |
| The draft I saved for a locked-out member has vanished | Unpaid drafts are removed 72 hours after they are saved | Make it again and confirm it yourself, or ask the member to pay within three days |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Membership & Members setup](membership-setup.md),
  [Membership Types](membership-types.md), [Subscriptions](subscriptions.md),
  [Age Groups](age-tier-settings.md), [Xero Sync](xero.md),
  [Book on Behalf](book.md).
- Reference: the
  [member subscription status transitions](../STATE_MACHINES.md#member-subscription-status-transitions)
  and
  [membership subscription charge lifecycle](../STATE_MACHINES.md#membership-subscription-charge-lifecycle),
  and the [membership subscription billing](../../CONFIGURATION.md#membership-subscription-billing)
  reference in `CONFIGURATION.md`.
