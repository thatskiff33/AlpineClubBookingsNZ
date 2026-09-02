# Booking Policies

Audience: Operator

## What it is

The hub for the rules that shape how bookings are priced, held, and refunded.
Five sub-pages sit under it:

- **Default Cancellation Policy** — the club-wide refund schedule and the
  "Members First" non-member hold.
- **Date-Specific Periods** — override the cancellation policy for named date
  ranges (for example school holidays).
- **Group Discount** — charge everyone at member rates once a booking is big
  enough.
- **Minimum Night Stay** — require a minimum number of nights when a booking
  touches certain days.
- **Public Booking Requests** — control indicative pricing and quote timing on
  the public request form.

Find it at **Admin → Rates & Policies → Booking Policies**
(`/admin/booking-policies`). Every setting here needs **bookings edit** access;
a view-only role can read the policies but not change them.

All money is integer cents (entered as dollars); all dates are NZ date-only
lodge nights. When the club runs more than one lodge, a **Rules for** selector
lets you set per-lodge overrides that *replace* (never merge with) the club-wide
rules — see
[`CONFIGURATION.md`](../../CONFIGURATION.md#adding-a-second-lodge).

## When you'd use it

- You need to change how much of a booking is refunded when a member cancels.
- A busy period (school holidays, a race weekend) needs stricter refund rules or
  a minimum stay.
- You want large bookings to be charged entirely at member rates.
- You want to turn indicative pricing on or off for the public request form, or
  change how long a quote stays valid.

## Step-by-step

### Open the hub

1. Go to **Admin → Rates & Policies → Booking Policies**. Pick one of the five
   cards.

   ![Booking Policies hub: five cards — Default Cancellation Policy, Date-Specific Periods, Group Discount, Minimum Night Stay, Public Booking Requests](../images/admin/admin-booking-policies.png)

   <!--
     The hub now carries a sixth card, Adult Member Hosting. Its own page is
     registered for capture as `admin-booking-policies-adult-member-hosting`
     (e2e/tools/capture-screenshots.ts); both images are refreshed by the usual
     capture run against a seeded stack, which this change could not perform.
   -->


### Default Cancellation Policy

1. Open **Default Cancellation Policy** and click **Edit**.

   ![Default Cancellation Policy: the Members First toggle, non-member confirmation threshold, and the cancellation refund rules table with a plain-English preview](../images/admin/admin-booking-policies-cancellation.png)

2. Set the **Members First booking policy** toggle. When on, non-member guests
   outside the threshold are held provisionally; when off, mixed bookings run as
   "First Paid, First In".
3. Set the **Non-member confirmation threshold** (days before check-in) that
   controls how long non-member bookings stay pending.
4. Edit the **Cancellation Refund Rules** table — one row per "days before
   stay" threshold, each with a card refund %, credit refund %, and optional
   fixed fees. The **Preview** restates the rules in plain English (for example
   "14+ days before stay: 100% refund"). Click **Save Default Policy**. Save
   stays greyed out until you actually change something, so opening **Edit**
   and clicking **Save** without touching a field never records a policy change
   you did not make. On a club that has never saved a cancellation policy, Save
   is available straight away so you can commit the starting rules once.
   **Cancel** puts every field back exactly as it was saved.

### Date-Specific Periods

1. Open **Date-Specific Periods** and click **Add Period**.

   ![Date-Specific Periods: the empty state explaining the default policy applies to all bookings, with an Add Period button](../images/admin/admin-booking-policies-periods.png)

2. Give the period a name, start and end dates, its own hold setting, and its
   own refund rules, then click **Create Period**. Any booking whose check-in
   falls inside the period uses these rules instead of the default.
3. To change an existing period, click its **Edit** button. **Update Period**
   stays greyed out until you actually change something, so re-saving an
   untouched period never records a change you did not make. **Cancel** closes
   the editor and leaves the period as it was.

### Group Discount

1. Open **Group Discount** and click **Edit**.

   ![Group Discount: the Enabled toggle, minimum group size, Summer seasons only checkbox, and the Apply to nights added after booking checkbox](../images/admin/admin-booking-policies-group-discount.png)

2. Tick **Enabled**, set the **Minimum group size** (the number of guests at
   which the whole booking is charged at member rates), and optionally
   **Summer seasons only**. Click **Save Group Discount**. The Save button stays
   greyed out until you actually change something, so opening **Edit** and
   clicking **Save** without touching a field never records a policy change you
   did not make. On a club that has never saved this policy, Save is available
   straight away so you can commit the defaults once and have the setup
   checklist show the group discount as configured.

3. **Apply to nights added after booking** decides what happens when a booking
   is edited later — the dates are extended, or another guest is added. Leave it
   ticked (the default) and those new nights get the discount too, exactly as
   they would have if they had been booked at the start. Untick it and only the
   original booking is discounted: anything added later is charged at the
   ordinary rate, and the member or officer editing the booking is told so
   beside the price. Either way, nights that were already booked keep the price
   they were booked at, so changing this setting never re-charges anyone for a
   night they have already paid for, and never changes a booking that is not
   being edited.

### Minimum Night Stay

1. Open **Minimum Night Stay** and click **Add Policy**.

   ![Minimum Night Stay: the empty state and Add Policy button for weekday minimum-stay rules](../images/admin/admin-booking-policies-minimum-stay.png)

2. Name the policy, set the minimum nights, the date range, and which
   **Trigger Days** (Sun–Sat) activate it. Choose **Exception capacity
   handling** explicitly:

   - **Hold requested capacity while it waits** means an exception request
     reserves the affected beds while the club decides — but not forever. The
     hold ends when the request is decided or when its deadline passes: 7 days
     after the request is raised, never past the start of the first night held,
     and never less than 24 hours. Once the deadline passes, the beds go back to
     the pool automatically and the request is marked **Expired**, so a request
     nobody decides cannot block the lodge indefinitely. The member who raised it
     is emailed when that happens, so they know to raise a fresh request rather
     than assume theirs is still waiting.
   - **Do not hold capacity until approval** means an exception request will
     reserve no beds until it is approved.

   Click **Create Policy**. The minimum stay applies whenever a booking includes
   any trigger day in the range. Existing policies start in **Hold** mode.
   This release stores, transfers, and publishes the choice, but a member who
   hits the rule is still stopped; submitting and approving exception requests
   arrives in the follow-up review workflow. The rule is applied wherever a
   member commits to nights: making a booking, changing the dates of an existing
   one, and joining a group booking — including a non-member signing up through
   a group's public link, who is checked both when they ask to join and again
   when they click the confirmation email, so a rule you tighten in between is
   honoured, and accepting a waitlist offer — including an offer for a different
   lodge, which is checked against that lodge's own rules. Admins and booking
   officers can still override the rule when booking or editing **on behalf of**
   a member; an admin booking for themselves is held to it like anyone else.
3. Your choice is stored, carried by configuration transfer, and shown on this
   card, but it is **not** published yet. The public booking-rules block lists
   each rule's nights, dates and trigger days only — it says nothing about
   exception capacity until members can actually request an exception, so
   nothing on your public pages promises a process that does not exist.
4. To change an existing policy, click its **Edit** button. **Update Policy**
   stays greyed out until you actually change something — including trigger
   days, where ticking a day and unticking it again counts as no change.
   Each save carries the row revision you loaded. If another admin or a config
   import changes it first, your stale save is refused and the current row is
   reloaded; reopen **Edit** and apply your change to that version.
5. Each row carries two different controls that used to look alike.
   **Deactivate** (outlined) is the reversible pause — the policy stops applying
   and the row shows an **Activate** button to bring it back. **Delete** (red)
   takes the policy out of use and records a `delete` in the audit log. Nothing
   is erased: the row stays listed as inactive, so the change remains auditable
   and the same **Activate** button can bring it back. Use **Delete** to say
   "this policy is finished", and **Deactivate** to say "not right now" — the
   difference is what the audit log records, not whether it can be undone.
   Both are one-click writes, so each button is disabled while it is working:
   clicking twice in a row does not record the same change twice.
6. Config transfer treats minimum-stay policies as one complete set. A bundle
   policy omitted from `booking-policies/minimum-stay.csv` is shown as
   **Deleted** in Preview and removed on Apply; a valid header-only file clears
   the set. Review every deletion and keep the automatic pre-apply backup. This
   is the sole replace-set exception — ordinary config categories do not delete.

### Adult Member Hosting

Some clubs want a club member present whenever non-member guests are staying.
This card asks for that, without ever leaving a member at a dead end.

The card carries **two separate settings**, and they are resolved
independently: what happens when a night is not covered, and which adult members
count as covering it. A lodge may override one and inherit the other.

1. Open **Booking Policies → Adult Member Hosting** and click **Edit**.
2. Choose what happens when a non-member guest is booked on a night with no
   adult member cover:

   - **Allowed — no adult member needed** turns the requirement off. This is
     what a club that has never configured the card already has.
   - **Allow the booking, but send it to a Booking Officer to review** flags such
     a booking for you to look at. The booking is still made and can still be
     paid — nobody is stopped, and nobody has to ring the club.
   - **Stop the booking unless it is corrected or an exception is approved**
     refuses it instead. The member is told which nights are not covered and is
     offered four ways forward: add adult member cover, change the guests or
     dates, choose another lodge, or ask a Booking Officer to approve an
     exception. **An exception request for a new booking holds no beds** — the
     capacity is checked again when the request is approved, so it can fail then.
     No upgrade turns this on: a club has to choose it deliberately.

3. Choose **Adult members who count**. Either inherit the choice above this scope
   or make your own, then tick the kinds of adult member that count. They are
   independent and combine with OR: a night is covered when at least one ticked
   kind covers it, and different nights of one booking may be covered by
   different people. Every non-member guest-night has to be covered — partial
   coverage across the stay is not enough.

   - **Eligible adult member on the same booking** — the rule the club has always
     had, and the only option a club that has never configured the card is using.
     It counts a qualifying adult member staying on the booking itself, for the
     nights they are actually there.
   - **Another booking on the same account** allows a qualifying adult member on
     another confirmed booking owned by the same member account to cover the same
     lodge and the same nights. This is the split-booking case: a member puts their
     family on one booking and their guests on another, and the adult on the first
     covers the second. It has to be the same member account — not the same
     surname, email address or family group, and not the administrator who entered
     the bookings — and the covering person has to be genuinely attending that
     exact night at that exact lodge. Turn it on only if your club works that way;
     a club with one booking per party does not need it.

   The card cannot be saved with your own set and nothing ticked. Turning the
   requirement off keeps your saved set for later; it just is not applied, and
   the card says so.
4. Read the **In force here now** panel before you leave. It states whether each
   of the two settings is inherited or set here, the values actually in force, and
   a plain-English preview of the resulting policy. It is computed by the same code
   the booking gates use, so it cannot disagree with them.
5. Choose **Exception capacity handling**. It has no automatic default, so pick
   one even while the requirement is off: it is what the club falls back on the
   moment you turn it on. The request-and-approve workflow uses this choice for
   a change to an existing booking: **Hold** keeps any extra beds the proposed
   change needs while it waits, while **Do not hold** leaves them available to
   somebody else. A request for a brand-new booking never holds beds because no
   booking exists yet. Availability is checked again when an officer approves
   either kind of request.
6. With two or more lodges a **Rules for** selector appears. A lodge can follow
   the club ("Use the club-wide setting") or make its own decision. The
   club-wide scope has no inherit option — there is nothing above it.
7. **Save Hosting Policy** stays greyed out until you have actually changed
   something, and each save carries the revision you loaded. If another admin or
   a config import saves first, yours is refused and the current settings are
   reloaded; reopen **Edit** and apply your change to those.

**Who counts as the adult member.** They must be a guest in their own right at
that lodge on that night. With **Eligible adult member on the same booking**, the
adult must be on the booking being checked. With **Another booking on the same
account**, they may instead be on another confirmed booking owned by the same
member account. Merely making or owning a booking is never enough — plenty of
members book for family who are travelling without them. Child or youth members
do not count, and neither does a member guest who has been invited but has not
accepted yet — they are not counted as being at the lodge anywhere else either,
so they cannot be the responsible adult here.

A member whose membership is inactive, cancelled or archived does not count
either, and for this rule the club treats them the same way it treats a guest:
their own nights need covering too. Members in good standing never need
covering; only non-member guest-nights do. If your club would rather that a
lapsed member still counted as a member for this one rule, say so and it can be
changed — it is a deliberate choice, not an accident.

**School and organisation bookings are not stopped.** They keep the review
behaviour whatever the club's consequence says: the uncovered nights are still
recorded for a Booking Officer, but the booking itself is never refused by this
policy. Those workflows have their own officer-managed approval and may be
supervised by teachers, leaders or custodians, which the adult club-member rule
does not describe.

**When the review goes away.** By itself, as soon as the facts change. Add an
adult member to the booking, remove the guest, move the nights, reinstate a
member, or turn the policy off, and the flag clears with no action from you. A
review you have already decided is only re-raised if the problem genuinely
changes — different guests or different nights — not because somebody corrected a
spelling.

**When "another booking on the same account" is on, a change can be refused.**
This is the one behaviour the wider setting adds beyond coverage itself, and it is
worth understanding before you turn it on.

Once one of a member's bookings is relying on the adult member staying on another,
the two are linked in practice. A member who then tries to cancel that other
booking, move its dates, change its lodge, take the adult member off it, or lose the
member-guest consent that put them there, is **stopped** with a message naming which
of their own bookings would be left uncovered, the lodge and the exact nights. They
are told to sort the affected booking out first, provide other cover, or ring a
Booking Officer. Nothing is written: their booking is exactly as it was.

Two things it deliberately does NOT do. It never mentions anybody else's booking —
every booking in that message is on the member's own account, and there is no way
for another account's booking to appear in it. And it never stops a change that
leaves alternative cover: if a THIRD booking on the account still has a qualifying
adult member on those nights, the change goes through and nothing is flagged,
because the rule asks whether cover exists, not whether one particular person is
still there.

**An officer can proceed, but never silently.** If your change would remove the
cover another booking relies on, the first attempt writes nothing and shows the
exact affected booking references, lodge and nights. Review that evidence, give
a private operational reason of at least 10 characters, confirm the warning and
try the change again. That acknowledged retry may proceed. Some system-driven
changes, such as a membership lapsing or a failed payment, cannot pause for that
interaction; they record the same problem for officer attention instead. In
either case:

- the affected booking **stays confirmed**, keeps its beds and keeps its payments.
  Nothing is ever cancelled automatically;
- it gets an urgent entry on the **Bookings without required adult member cover**
  card on the admin dashboard's stuck-state list, which is how anybody finds out;
- the booking owner is emailed once, naming the lodge and the uncovered nights;
- the whole thing is in the audit log, with your reason where the screen you used
  captured one;
- the entry clears **by itself** when the problem goes away — cover is restored, the
  booking is amended, an exception is approved, or the booking is cancelled. You do
  not tick anything off.

Re-running the same check does not re-send the email or duplicate the entry: the
club tells the owner when the situation actually changes, not every time a background
job looks at it.

**A member moving one of their own bookings is asked, not stopped.** This is the
one case that used to go wrong in both directions, and it is worth reading in full
because the answer is a question rather than a refusal.

Suppose a member has two bookings at the same lodge on the same nights — one
carrying the qualifying adult, one carrying the children — and the second is
compliant only because of the first. If they move the booking with the adult on it,
the other one loses its cover.

Until #3232 nothing happened at all: the second booking stayed marked as fine,
nobody was told, and nothing reached your queue. Nothing would have looked at it
again either, because the club only re-checks a booking when something touches it
and its owner had no reason to touch it. It could have sat like that until the
night itself.

The obvious fix — refuse the move — was tried on paper and does not work. Moving
the *other* booking is refused by the same rule from the other end, because moving
it away from the adult leaves it with no adult. A member wanting both of their
bookings on different nights could have moved neither. So instead they are offered
the thing they were actually trying to do:

> Booking BK-1234 is relying on this booking for adult supervision. Move both
> together?

- **Move both bookings.** They move together, on **one combined figure the member
  accepts once** — both bookings repriced for the new nights, both change fees,
  and a single card-or-credit choice covering both. Either both move or neither
  does; there is no state where one moved and the other did not.
- **Move only this booking.** The change goes ahead, the member is told in plain
  words on the screen that the other booking will be left without adult
  supervision, and it arrives in your queue exactly as an officer override would —
  urgent entry, owner emailed, audit trail. The entry records that a member was
  asked and chose this, so you are not left guessing whether somebody decided it or
  a qualification quietly changed.
- **Where the beds are not there for both**, the first option is not offered. The
  member is told plainly that there are not enough beds free on the new nights, and
  the second option is still there. A full lodge never stops somebody moving their
  own booking.

Whether the **second** change fee is charged is your club's choice — see
"Charge the change fee on both bookings" on the Cancellation page. It defaults to
charging both, because both bookings really do move.

**Booking on behalf of a member.** If the party would trip the rule, you are
stopped once and asked for a reason. A panel appears on the review step with a
box for it; type the reason and click **Record the reason and create**. Saving as
a draft asks the same question in the same place. The reason and your name are
stored with the booking, so "who let this through, and why" has an answer months
later.

**Requests you approve.** Approving a public booking request, a school request or
a member's whole-lodge request never asks you for a reason, and under **Allow the
booking, but send it to a Booking Officer to review** it is never blocked either —
but because those parties are all non-member guests, the booking appears for review
just like any other. Approving the request is not the same as accepting the hosting
exception, so the review stays open until somebody decides it.

Under **Stop the booking unless it is corrected or an exception is approved** the
picture changes for two of the three. A public booking request and a member's
whole-lodge request are both stopped: the approval is rolled back untouched and you
are told which rule stopped it, with no exception link, because you reading the
message are already the person an exception would be asked of. Your options are to
put a qualifying adult member in the party, move the request to another lodge, or
change the lodge's setting. **School and organisation requests are the exception**:
they keep their current behaviour whatever the consequence says, because they run a
separate officer-managed process and may be supervised by teachers, organisation
leaders or custodians who do not map onto the adult club-member rule.

**What the public sees.** When the requirement is on, the public booking-rules
block states it in one sentence. It says nothing about asking for an exception,
because there is nowhere to ask yet.

### Public Booking Requests

1. Open **Public Booking Requests**.

   ![Public Booking Requests: the indicative-pricing card and the quote-window and school-attendee timing cards, each with its own Edit button and shaded read-only boxes](../images/admin/admin-booking-policies-public-requests.png)

2. To change **Show indicative pricing on the request form**, click **Edit** on
   the Indicative Pricing card, tick or untick the box, then click **Save
   indicative pricing**. **Cancel** puts it back the way it was. Nothing changes
   on the public site until you save, so an accidental click on the box is
   harmless. With it on, the public form is "Request to Book" and shows a price;
   with it off, it is "Request for Price" and shows none until an officer
   reviews it.
3. The two timing cards below work exactly the same way. Click **Edit** on
   **Quote Response Window & Reminders**, set the **Quote response window** and
   **Reminder lead time**, then click **Save quote timing**. Click **Edit** on
   **School Attendee Confirmation**, set the prompts, then click **Save attendee
   prompts**. Each card has its own **Cancel**, which puts that card's boxes back
   the way they were saved and leaves the other cards alone. Save stays greyed
   out until you actually change something, so opening **Edit** and closing it
   again never records a change you did not make.
4. You can have more than one card open at once, and each keeps its own draft —
   cancelling one does not touch what you have typed in another. While a card is
   saving, the whole section is briefly locked, because all three cards write the
   same settings record and only one of them may be in flight at a time.
5. Each card sends back only the boxes you actually changed, so if another admin
   changed one of the others while your page was open, your save leaves theirs
   alone and the card shows you their value afterwards. Note that clicking
   **Edit** does not re-read the settings — a card shows what it loaded with
   until something is saved from it. Reload the page if you need to be sure you
   are looking at current values.

## Settings reference

| Setting | Page | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- | --- |
| Members First booking policy | Cancellation | Hold non-member guests provisionally vs "First Paid, First In" | on | Club-wide only |
| Non-member confirmation threshold | Cancellation | Days before check-in that non-member bookings stay pending | 7 | 1–365 days |
| Cancellation refund rows | Cancellation | Refund % (card and credit) and fixed fees per days-before-stay threshold | 14→100%, 7→50%, 0→0% | Fees entered in dollars, stored as cents; the highest matching threshold wins |
| Cross-lodge waitlist queue order | Cancellation | How cross-lodge waitlists are ranked | Own lodge first | Multi-lodge only |
| Period name / dates / rules | Periods | A named date-range override of the cancellation policy | none | NZ date-only; replaces the default for matching check-ins |
| Group discount enabled | Group Discount | Charge all guests at member rates for big bookings | off | — |
| Minimum group size | Group Discount | Guest count that triggers the discount | 5 | 2 up to lodge capacity |
| Summer seasons only | Group Discount | Restrict the group discount to summer | on | — |
| Apply to nights added after booking | Group Discount | Whether a later edit (extra nights, extra guests) earns the discount on the nights it adds | on | Nights already booked keep their booked price in either state; a club with the discount off is unaffected |
| Minimum nights | Minimum Stay | Nights required when a trigger day is included | 2 | Minimum 2 |
| Trigger days | Minimum Stay | Which weekdays activate the rule | Sat | At least one day |
| Exception capacity handling | Minimum Stay | Whether a future exception request holds the affected capacity while it waits | Existing rows: Hold | Required on create; Hold wins when several eligible rules apply; a hold ends when the request is decided or its deadline passes (7 days, never past the first night held, never under 24 hours) |
| Non-member guests without adult member cover | Adult Member Hosting | Allowed; allowed but sent to a Booking Officer; or stopped unless corrected or an exception is approved | Allowed (club); Use the club-wide setting (lodge) | The club-wide scope cannot inherit; no upgrade selects "stopped" |
| Adult members who count | Adult Member Hosting | Either or both of: on the same booking; on another booking on the same account | Inherit (lodge and club) — the built-in default is "on the same booking" | At least one must be ticked when you set your own; there are two options and no others |
| Exception capacity handling | Adult Member Hosting | Whether a future exception request holds the affected capacity while it waits | None — you must choose | Required on every save; the same hold deadline applies |
| Charge the change fee on both bookings | Cancellation (club-wide) | Whether a member who moves two of their own bookings together, because one relies on the other for adult supervision, pays the change fee on both | on — charge both | Club-wide only, like the non-member hold beside it; the fee *tiers* stay per lodge. Off charges only the booking the member was editing |
| Paid-up adult member required | Configured on [Subscription Lockout](subscription-lockout.md), not here | Refuses a booking with no paid-up adult member on it, when either somebody staying is being repriced for an unpaid subscription or the member who made the booking has one | Off (only applies when you choose "let them book, at non-member rates") | Always holds the bed while a request is pending; not configurable |
| Show indicative pricing | Public Requests | Price shown on the public request form | off | — |
| Quote response window | Public Requests | Days a quote link stays valid | 14 | 1–60 days |
| Reminder lead time | Public Requests | Days before expiry to remind the requester | 3 | 0–30, must be shorter than the window |
| Attendee first prompt / reminder | Public Requests | Timing for both guest-naming chases: the school attendee-confirmation prompt and the member whole-lodge "who is coming with you?" reminder (which escalates to daily from two days out, with a last one on the arrival morning) | 14 / 3 days | Prompt 0–90 (0 = off, both chases); reminder 1–30 |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Every field is read-only, and a banner at the top of the section says "You have view-only access to this area" | Your admin role is view-only for bookings | Ask a full admin for bookings edit access |
| A **Save** button is greyed out and there is no view-only banner | You have not changed anything yet | Change a field to enable Save. Every section's Save only lights up once the form differs from what is saved, so an accidental re-save cannot record a change you did not make |
| A **Save** button went grey part-way through editing, and the view-only banner appeared | Your bookings access was reduced while you had the form open | Reload the page and ask a full admin for bookings edit access |
| A section says "Could not load…" and shows no editor and no list | Its policy or list could not be fetched, so what is stored is unknown — either on first load, or after switching **Rules for** to a lodge | Click **Try again** on that card. Nothing is shown deliberately: what was on screen belongs to a different scope, or is only this form's built-in starting values, and editing, removing, or deactivating it from here would change the wrong thing. The **Rules for** selector stays available throughout, so you can also switch scope instead |
| A "Public copy may be out of date" banner | Your Terms/FAQ still describe the old non-member hold | Click **Edit public pages** and update the copy to match the current policy |
| A period's rules are not applying | The booking's check-in is outside the period, or the period is inactive | Check the dates and the Active toggle on the period card |
| A booking is flagged for hosting review even though a member is on it | The member is not a guest on the affected night, or their membership is a child/youth tier or is inactive, cancelled or archived | Open the booking's guest list and check who is staying on that night, then check the member's record |
| Adult Member Hosting says it cannot load the settings for a lodge | The load for that scope failed, so nothing is shown rather than another lodge's values | Click **Try again**; do not save until the settings for the lodge you chose are on screen |
| Group discount never triggers | It is disabled, the group is under the minimum, or it is summer-only and the stay is in winter | Enable it, lower the minimum group size, or untick Summer seasons only |
| A minimum-stay update closes and the row changes back | Another admin or a configuration import saved a newer row revision first | The stale write was refused and the current row was reloaded. Reopen **Edit**, review the current values, and make the change again |
| A minimum-stay save says the name is already in use | Another **active** rule in the same place (club-wide, or the same lodge) already has that name, and configuration transfer identifies a rule by its name | Give this rule a different name, or deactivate the other one first. A rule you have already deactivated does not block the name |
| Exporting settings fails and names two minimum-stay rules | Two rules in the same place share a name — usually one deactivated and one recreated with the same name | Open Booking Policies, rename one of the two rules the message names (the deactivated one counts), then export again |
| Reminder lead time won't save | It is not shorter than the quote response window | Set a lead time shorter than the window |
| A Public Booking Requests number box is shaded and will not accept typing, and there is no view-only banner | That card is not open for editing yet — its boxes are read-only until you open it | Click **Edit** in that card's header. The boxes turn white and **Save** and **Cancel** appear |
| A Public Booking Requests card says "the quote timing has been changed since this page loaded" | The quote response window or the reminder lead time changed while your page was open — another admin, you in a second tab, or a configuration import — and your change would leave the reminder no shorter than the window. Nothing was written | Reload the page to see the current values, then make your change again |
| A Public Booking Requests card says "Your change was not saved: the current settings could not be re-read" | Each of that section's three cards re-reads the stored settings just before it writes, so it cannot overwrite another card. That read failed, so nothing was written | Click **Save** again. Your typing is still in the box — nothing was lost and nothing was changed |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Booking Requests](booking-requests.md),
  [Seasons](seasons.md), [Promo Codes](promo-codes.md),
  [Payments](payments.md).
- Reference: the cancellation refund policy and GST treatment in
  [`CANCELLATIONS.md`](../CANCELLATIONS.md#refund-policy), the
  [refund and credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle),
  per-lodge overrides in
  [`CONFIGURATION.md`](../../CONFIGURATION.md#adding-a-second-lodge), and the
  [public booking request quote lifecycle](../STATE_MACHINES.md#public-booking-request-quote-lifecycle).
