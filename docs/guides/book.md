# Book on Behalf

Audience: Operator

## What it is

A guided wizard that lets an admin create a booking *for* someone — an existing
member, or a non-member walk-in/phone guest entered inline — without the member
having to log in and book themselves. It walks you through choosing the owner,
picking dates, adding guests, and confirming, and it can email the member (or
not) at the end. Find it at **Admin → Bookings & Beds → Book on Behalf**
(`/admin/book`), or via **+ Create Booking** on the [Bookings](bookings.md) list.

Admin bookings created here bypass the member-facing minimum-stay rules and can
exceed live availability up to the lodge's hard capacity (you confirm any
over-capacity override at the final step). Money is integer cents; dates are NZ
date-only lodge nights. The behaviour and its guardrails are documented in
[`CONFIGURATION.md`](../../CONFIGURATION.md#book-on-behalf).

## When you'd use it

- A member phones or emails to ask you to make a booking for them.
- A non-member walk-in or phone guest wants a bed and has no login.
- You need to record a stay that already happened (a retroactive booking, up to
  365 days back).
- You want to apply account credit or a promo code to a booking as you create
  it.

## Step-by-step

### Choose who the booking is for

1. Go to **Admin → Bookings & Beds → Book on Behalf**. If your admin role is
   view-only for bookings you will see a notice that you cannot create
   bookings; the action buttons are disabled.
2. Choose the owner type with the two buttons: **Existing member** or
   **Non-member booking**.

   ![Book on Behalf page: Existing member / Non-member booking toggle and the member search box](../images/admin/admin-book.png)

3. **Existing member:** type at least two characters of a name or email into
   **Search for a member to book on behalf of**, then pick the member from the
   dropdown. A confirmation card shows "Booking on behalf of: {name}" with a
   **Change** button.
4. **Non-member booking:** fill in **First name**, **Last name**, **Email**
   (or tick **No email address** for a phone/walk-in guest), and optional
   **Phone**. The form suggests existing contacts so you can reuse one instead
   of creating a duplicate. These guests are billed at non-member rates and are
   never sent login emails.

### Step 1 — Select Dates

1. If the club runs more than one lodge, pick the lodge first (switching resets
   the dates and pricing).
2. To record a past stay, tick **Record a past stay (retroactive booking)**
   (allowed up to 365 days back).
3. Choose the check-in and check-out dates on the calendar. The stay covers
   the nights from check-in up to — but not including — the check-out date,
   which is the departure morning, not a stayed night. As an admin you are not
   blocked by member minimum-stay rules.

### Step 2 — Add Guests

1. Use the **Quick add {name}'s family members** chips to add the member and any
   family in one click, or add guests manually in the guest form.
2. If the booking exceeds the beds available for those dates, an orange banner
   warns you — you can still continue and confirm the over-capacity override at
   the end.
3. Click **Continue** to price the booking.

**If a guest you type has the same name as one of the member's own dependants,
you are asked which person it is.** The club records who somebody's dependants
are, and a dependant belongs on the member side of the party: a bed at the
member rate. Typed as an ordinary guest they may instead be held provisionally —
no bed reserved until the booking is confirmed and paid, bumpable if the lodge
fills, invoiced separately at non-member rates. The person that happens to is
usually a child, and their parent is not at the screen to notice, so the page
will not go on until you say which person you mean:

- **This is {name}'s dependant — book them as a member** moves the row onto the
  member side. It is offered when that dependant is in the member's family
  group; when they are not, the page says to put them in it under **Membership**
  first, because that is what this screen adds members from.
- **This is a different person with the same name** leaves them as a guest. You
  answer once per dependant, and because the question is about the name,
  answering once covers every guest on the booking with that name.

Only the **selected member's** own recorded dependants are ever compared, and
only on an exact name match. Nothing here searches other families or the
membership list. The answer is checked again when the booking is created, and is
not kept as a record afterwards — if it matters, put it in the booking notes.

**Member guests are added after saving, from the booking's edit panel.** With
the **Member guests** module on, a member from outside the owner's family group
can be put on a booking — but there is no **+ Add Member Guest** button on this
page. Create the booking with the owner's own family and any non-member guests
first, then open it from **Bookings**, click **Edit**, and use **+ Add Member
Guest** there.

The reason is worth knowing rather than guessing at: the officer's member finder
is scoped to a booking, so that the lookup can be gated and audited against a
booking that exists. During creation there is no booking to scope it to. Adding
the member guest from the edit panel does exactly the same thing — the same
consent record naming you, and the same email to the member — one step later.
The member guide's *Being added to a booking by another member* page describes
what that member receives.

### Step 3 — Review & Confirm

1. Check the **Booking Summary** (dates, nights, guests, and per-guest prices).
   If the member has account credit, tick **Apply credit to this booking** to
   use it. Add a promo code with the promo field if you have one.
2. Add optional **Notes** and an **Expected Arrival Time** if relevant. The
   arrival time is **information only** — it tells the hut leader roughly when
   to expect people, and it appears on the lodge kiosk and on the lobby display
   wall. It does **not** change the booking's dates, what is charged, or who is
   put on the chore roster: a guest night runs midday to midday, so a guest is
   on the roster for their check-out morning regardless of any time recorded
   here. Someone who wants to leave early talks to the hut leader. The dropdown
   runs from 6:00 AM to 11:00 PM on the hour and half hour; the system accepts
   any half hour of the day, so an out-of-hours arrival can still be recorded
   through the API or just mentioned to the hut leader. If the
   booking has minors without an adult, an admin reason box appears — because
   you are an admin the booking is auto-approved, and the reason is stored in
   the audit trail.
3. If Internet Banking is enabled and there is money to pay, choose the
   **Payment method** (Card or Internet Banking).
4. Click **Confirm Booking** (or **Save as Draft** to hold it without
   confirming). Over-capacity bookings must be confirmed with the explicit
   over-capacity button and cannot be saved as drafts.
5. In the **Email the member about this booking?** dialog, choose **Create and
   email member** or **Create without emailing**. Your choice is recorded in the
   audit log.

   Choosing **Create without emailing** also stops Xero emailing the invoice
   for this booking on the Internet Banking path. The invoice is still raised
   in Xero and the member still owes it — only the email is held back, and the
   booking page lists it among the messages that were withheld. If you decide
   the member should have it after all, send that one invoice from Xero;
   nothing here re-sends it.

   This is a one-off for this booking creation and nothing more. It does not
   turn on the booking's **No emails** switch, does not change the member's
   address in Xero, and does not stop any later reminder, change or
   cancellation email.

### Leave it for the member to pay: Save as Draft

**Save as Draft** creates the booking but does not take any money. The member
signs in, opens it, and pays for it themselves — and *paying* is what confirms
the booking, so nobody has to come back to you.

Three things are worth knowing before you use it:

- **It works for a member you have locked out.** If your club stops unpaid
  members from booking (see [Subscription Lockout](subscription-lockout.md)),
  that stops them *starting* a booking. It has never stopped them paying for one
  you made for them. So a member who owes their subscription and needs a bed this
  weekend can be booked in this way, and they settle the hut fee themselves. Their
  subscription is a separate debt and is still owed.
- **The member sees it.** It appears on their dashboard as a draft labelled
  "Saved for you by the club", with a **Review & pay** button. There is no
  automatic email about a draft, so tell them it is waiting.
- **Drafts are removed after 72 hours.** An unpaid draft is deleted, not
  cancelled — after that there is nothing to pay and the booking has to be made
  again. If the member cannot pay within three days, confirm the booking instead
  and chase the money the usual way.

**A non-member owner with no login can never pick a draft up.** The wizard also
books a non-member as the owner (see "When you'd use it" above — someone with no
login at all). They have no dashboard to open, no way to sign in, and nothing is
emailed about a draft — so a draft saved for them is a booking nobody can pay,
and it is **deleted after 72 hours** with the beds never held. The review screen
says so where you choose. Press **Confirm Booking** for that owner, or save the
draft only if *you* are coming back to confirm it within three days.

**A $0 booking has nothing for the member to pay, so confirm that one
yourself.** With no money owing there is no payment step on their screen — the
booking offers them a **Confirm** button instead, and that button refuses a
member whose subscription is unpaid. Use **Confirm Booking** here rather than
**Save as Draft**, or confirm it from the booking's own page afterwards.

## Settings reference

This is a wizard, not a settings page. The inputs it collects:

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Owner type | Existing member vs inline non-member | Existing member | Non-members are billed at non-member rates |
| No email address | Suppress all owner emails (walk-in/phone) | off | Creates a placeholder-email owner; nothing shared with Xero |
| Record a past stay | Create a retroactive booking | off | Up to 365 days back; drafts disabled for these |
| Lodge | Which lodge the booking is at | first/only lodge | Only shown with more than one active lodge |
| Guests | Who is staying | — | Capped at the lodge's resolved capacity, not live availability. Member guests (members outside the owner's family) are added afterwards from the booking's edit panel — see Step 2 |
| Apply credit to this booking | Spend the member's account credit | off | Money in integer cents |
| Notes | Free-text booking notes | empty | Notes ≤ 1000 characters |
| Expected Arrival Time | Roughly when the party expects to reach the lodge — information for the hut leader only | not set | On the hour or half hour. The dropdown offers 6:00 AM–11:00 PM, which covers every ordinary arrival; the system itself accepts any half hour of the day, so a genuine after-midnight arrival can be recorded through the API or simply mentioned to the hut leader. Shown on the kiosk and the lobby wall; changes no date, no charge and no chore assignment. Editable afterwards from the booking page until the check-in date passes; every set and clear is recorded in the audit log |
| Payment method | Card or Internet Banking | Card | Internet Banking option only when the module is on and a balance is due |
| Email choice | Whether the member is emailed | asked at confirm | Recorded in the audit log |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The whole page shows a view-only notice | Your admin role can view booking tools but not create bookings | Ask a full admin for bookings edit access |
| Only the lodge kiosk matched the member search | You searched a term that only matches the shared kiosk login | Search by the member's own name or email — the kiosk cannot own bookings |
| "Some nights are over lodge capacity" panel | The booking exceeds available beds | Review the per-night list and press **Confirm over-capacity and create**, or reduce guests/dates |
| Confirm fails with a XERO_PERIOD_LOCKED error | The Xero accounting period for that date is locked | Choose a date outside the locked period, or unlock the period in Xero |
| Cannot Save as Draft | The booking is retroactive or over-capacity | Confirm it instead — drafts are not allowed for those |
| Continue refuses with "has the same name as somebody recorded as this member's own dependant" | A typed guest name exactly matches one of the member's recorded dependants | Answer the question on the guest step — book them as a member, or say it is a different person with the same name |
| The dependant question offers no "book them as a member" button | That dependant is recorded by a parent link but is not in the member's family group, and this screen adds members from the family group | Add them to the family group under **Membership**, then start the booking again |
| The member says the draft you saved has disappeared | Unpaid drafts are removed 72 hours after they are saved | Make the booking again, and either confirm it yourself or ask them to pay within three days |
| A locked-out member cannot complete the free booking you saved for them | A $0 draft has no payment step, and the confirm button refuses an unpaid member | Confirm it for them from the booking page, or use **Confirm Booking** instead of **Save as Draft** |
| You saved a draft for a non-member owner and nothing happened | They have no login, no dashboard and no draft email, so nobody can pay it — and it is deleted after 72 hours | Confirm the booking instead, or open the draft yourself and confirm it within three days |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Bookings](bookings.md), [Booking Requests](booking-requests.md),
  [Promo Codes](promo-codes.md), [Bed Allocation](bed-allocation.md),
  [Subscription Lockout](subscription-lockout.md).
- Reference: [`CONFIGURATION.md`](../../CONFIGURATION.md#book-on-behalf) for the
  book-on-behalf rules, the
  [booking/payment flow](../ARCHITECTURE.md#booking-and-payment-flow), and
  [capacity resolution](../CAPACITY_MODEL.md#which-bookings-consume-capacity-the-holding-population).
