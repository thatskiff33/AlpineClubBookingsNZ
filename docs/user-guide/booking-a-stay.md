# Booking a stay

Audience: Member, Guest

## What it is

The booking wizard where you choose your lodge nights, add everyone in your
party, and confirm. Members start at **Book** in the top navigation (`/book`).
Whether someone without a login can stay at all is the club's own decision (see
[Guests without a login](#guests-without-a-login) below). The wizard runs in four
steps — **1. Select Dates → 2. Add Guests → 3. Review & Confirm → 4. Pay** — and
the last step becomes **Admin Review** for a booking that needs committee
sign-off (for example one that includes minors).

To book at **member rates** your membership subscription must be paid up. The
full booking state machine is in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#booking-lifecycle).

## When you'd use it

- You want to stay at the lodge on specific nights.
- You are bringing family or friends — some members, some not.
- You are organising a trip and want others to book their own beds on the same
  dates (a group trip).
- The nights you want are full and you want to join the waitlist instead (see
  [The waitlist & offers](waitlist-and-offers.md)).

## Step-by-step

### 1. Select your dates

1. Click **Book** in the top navigation (`/book`). The wizard opens on **Select
   Dates**.

   ![The Book a Stay wizard step 1 showing the four-step cue and a month calendar with each night colour-coded by how full it is](../images/public/member-book.png)

2. Pick your **check-in** date, then your **check-out** date. Nights are NZ
   date-only lodge nights — a stay of "7 Sept — 9 Sept" is two nights (the 7th
   and the 8th).
3. Each night on the calendar is colour-coded by availability, with a legend
   below it: **Available** (more than 15 beds free), **Filling** (6–15 beds),
   **Nearly full** (1–5 beds), and **Full**. A small season marker (e.g. "W
   Winter 2026") shows which season's rates apply — rates differ by season.
4. If the nights you want are **Full**, you can join the waitlist instead of
   booking — see [The waitlist & offers](waitlist-and-offers.md).

### 2. Add your guests

1. Continue to **Add Guests**. **You are added to the party by default** — you
   can remove yourself if you are booking only for others.
2. Add each guest. A guest who is another club member can be added as a **member
   guest** (member rate, their own bed held). A guest who is not a member is a
   **non-member guest** (non-member rate).
3. If you type a non-member guest whose name matches someone in your own family
   group who can be booked as a linked member, the wizard offers a one-click
   **Add as member guest** suggestion — a suggestion only, never forced. Taking
   it books them at the member rate with a bed held (no provisional hold).
4. If the name you type is **exactly** the name of one of **your own recorded
   dependants**, that is not a suggestion but a question you have to answer
   before you can go on. Your dependant is a member of the club and should have a
   bed held at the member rate; booked as a guest they may instead be held
   provisionally, depending on how far ahead you are booking — no bed reserved
   until the booking is confirmed and paid closer to your stay, and members have
   priority if the lodge fills. So the wizard asks which person you mean:

   - **This is my dependant** — they move onto the member side of the party. If
     they cannot be added from this screen yet, it says what has to happen
     first, and who can do it: sometimes that is something you finish in your
     own profile, and sometimes it is the club, because a dependant can be
     recorded as yours without being in your family group.
   - **This is a different person with the same name** — the guest stays a
     guest. You are asked once per dependant, so if two of your dependants share
     a name you answer for each of them; and because the question is about the
     name, answering once covers every guest on the booking with that name.

   The club only ever compares what you type against **your own** recorded
   dependants, and only when the name matches exactly. It never searches other
   families or the membership list, so this cannot be used to find out whether
   somebody is a member.

   Your answer is used to let this booking go through, and is **not** kept as a
   record afterwards. If you want the club to know about it, say so in the notes
   or tell them.
5. **Adding another member who is not in your family group** (only if your club
   has turned this on): a **+ Add Member Guest** button sits beside **+ Add
   Non-Member Guest**. Most clubs ask you for the person's **exact email
   address** — the one the club has for them — because the club does not list its
   members here. Type it in and press **Find**. If more than one member uses that
   address (a household), you pick the right person from a short list showing
   their name and age group and nothing else. Some clubs also turn on searching
   by **name**, in which case the same box takes either a name or an address; the
   admin who turns that on is told, in plain words, that it makes the club's
   member list browsable to anyone who can start a booking.

   Two things worth knowing before you add someone:

   - **They can see the booking straight away**, including the other guests'
     names, from the moment you add them — before they have said yes.
   - **Their answer covers the whole booking**, including changes you make later.
     If you move the dates, you are not asked again.

   If the club cannot add that person, you get one short sentence saying so and
   no reason. That is deliberate: the club will not tell one member about
   another's bookings, subscription or details. If you think it is wrong, ask
   them directly, or ask the club.
6. **Make this a group trip** (optional): tick it if you want other people to
   book their **own** beds on the same dates. You choose whether each person pays
   their own bill or you pay one combined bill, and you get a join code/link to
   share. Full detail is in
   [`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md) (the "Group trip organiser" journey).

### 3. Review, confirm, and the hold policies

Step 3, **Review & Confirm**, shows your nights, your party, and the quote in
dollars before you commit. What happens to any **non-member guests** depends on
which of two booking policies your club runs. Operators call these policies
*First Paid, First In* and *Members First*, but you will **not** see those names
anywhere in the wizard — you only see their effect:

- **When First Paid, First In applies** (or when your stay is already inside the
  club's hold window): your whole party — members and non-members alike — is
  booked together and goes straight to normal payment. The submit button reads
  **Continue to Payment** when money is due.
- **When Members First applies** (your stay is far enough out that an enabled
  Members First hold will actually be created): your **member** places are booked
  and charged now, while your **non-member** guests are held **provisionally** — no
  bed is reserved for them yet. The review step spells this out (a "provisional
  guests" note): which guests are provisional, that today's charge covers only
  the member places, the separate guest-portion amount, and that it is "because
  your stay is more than N hold-days away". You also see a **"Only book if my
  guests can come"** choice, so you are never forced to take a member-only place
  if your guests might be bumped.

Under a Members First split, your non-member guests' portion is **auto-charged to
the same card around the hold deadline** if beds remain — otherwise those guests
are bumped and only your own place stands. Your booking-confirmed email repeats
the same provisional-guests note. See
[Paying for your stay](paying-for-your-stay.md#split-charges-for-non-member-guests)
for the money side, and the
[booking lifecycle](../STATE_MACHINES.md#booking-lifecycle) for the states.

### 4. Pay (or wait for review)

- If money is due and you are paying by card, the **Pay** step takes payment
  inside the wizard. If you close the wizard before paying, it is safe: your
  booking page keeps a **Complete Payment** card and an amber "Payment required"
  banner so you can finish later.
- If your booking needs committee sign-off, step 4 reads **Admin Review** instead
  and no payment is taken until it is approved.

Paying by card versus by internet banking is covered in
[Paying for your stay](paying-for-your-stay.md).

### After you book: My Bookings

Your bookings live at **My Bookings** (`/bookings`), sortable by start date and
filterable by status.

Emails about one of your bookings take you straight to that booking's detail
page when you are signed in and allowed to open it. If an email is sent to a
public contact who does not have a login, its secure payment, quote, or response
link still works as described in that email; it is not replaced with a sign-in
link the recipient cannot use.

![The My Bookings list showing two bookings, one with a Waitlist Offered badge and one with a Payment Pending badge, each with dates, guest count, and price](../images/public/member-bookings.png)

A provisional non-member guest created by a Members First split appears as an
**indented sub-row nested inside its parent member booking** — one card carrying
both the parent's and the guest's own status badges. Open the booking to see a
**Your non-member guests** section listing each guest, their status, dates,
count, and amount. Your dashboard's **Next Stay** card also shows a "how full for
your dates" occupancy meter.

### A booking the club saved for you

Sometimes the booking is already made when you sign in. Someone at the club can
make a booking **on your behalf** and leave the payment to you — you will see it
in your **Draft Bookings** card on the dashboard, labelled **"Saved for you by
the club"**, with a **Review & pay** button.

Open it, check the dates and who is on it, and pay. **Paying is what confirms
it** — nobody has to come back to the club. Two things to know:

- **This still works when your subscription is unpaid.** If your club stops
  members with an unpaid subscription from booking, that stops you *starting* a
  booking of your own. It has never stopped you paying for one the club saved for
  you — the hut fee for the stay and your subscription are two different debts,
  and the subscription is still owed.
- **Pay it within 72 hours.** An unpaid draft is **removed** three days after it
  is saved — deleted rather than cancelled, so there is nothing left to open and
  the booking has to be made again. Nothing is emailed about a draft, so if the
  club told you one is waiting, do not leave it.

If the booking comes to **$0** there is nothing for you to pay and no payment
step appears — ask the club to confirm that one for you.

## Guests without a login

**Whether the club hosts non-members, and on what terms, is set by the club — not
by this website.** Many clubs only take non-members as guests accompanied by a
member, if at all. Before you plan a stay, read the club's own FAQ, rules, or
policy pages (look in the site menu or footer) or ask through the club's contact
page.

There are two paths that need no login. Neither is an open invitation to book —
both are requests the club reviews and can decline:

- **Request a guest booking** — the request form is **not linked from the
  sign-in page, or from any other page you can browse to**. The club sends its
  direct link to a guest it has agreed to host (its admins copy that link from
  the Booking Requests area); the only other way back to it is the **Book these
  dates again** button on a payment link the club emailed you for an earlier
  stay. Once your request is in, the club replies with a secure quote link. You
  open it to review the price, options, and expiry, then **accept**, **cancel**,
  **ask a question**, or **request changes**. Accepting is how a guest confirms;
  the quote states when it expires.
- **Request a school group booking** — for a school or organisation trip, still
  linked from the sign-in page (`/login`). The club prices it and, closer to
  check-in, emails you a secure link to confirm each attendee's name for the
  lodge roster.

These flows are the "Public quote requester" and "School contact" journeys in
[`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md); operators handle them with the
[Booking Requests](../guides/booking-requests.md) guide.

## What it costs / what to expect

| Thing | What to expect |
| --- | --- |
| Member rate | Available only while your membership subscription is paid up |
| Nights | NZ date-only lodge nights; the season sets the per-night rate |
| Capacity | A **Full** night cannot be booked — join the waitlist instead |
| One booking per member per night | You cannot hold two overlapping bookings for the same member night |
| Minimum stay | Some periods enforce a minimum number of nights (a club policy). If your dates fall short you can ask a Booking Officer to allow it — see below |
| Non-member guests (Members First) | Held provisionally, charged around the hold deadline, bumped if no bed remains |
| Non-member guests (First Paid, First In) | Booked and paid with the rest of the party |
| Group trip | Each joiner holds their own bed; you choose each-pays-own or you pay one bill |
| Dietary/allergy notes | If your club collects them, each member you add to a booking — you included — brings the note from their own profile, copied once for this stay. The booking form does not ask for them. To change a note for this trip only, or to add one for a guest without a login, contact the club: booking officers can edit the stay's copy without touching anyone's profile. Only booking officers and the hut leader running the stay see them |
| Naming your party | Where a booking was set up from a headcount rather than a list of names — a whole-lodge or a school/organisation booking — the club emails you as check-in approaches asking you to fill the real names in, more often in the last couple of days. The names are what the lodge chore list and arrival roster print. Renaming somebody does not change their age group or the price. **It never holds up your stay:** come whether or not you got to it, and tell the lodge on arrival |

Prices are shown in dollars (formatted from the cents the club stores). The
policies behind minimum stay, group discount, and cancellation are set by the
club — see the operator [Booking Policies](../guides/booking-policies.md) guide
and [`booking-dates-and-capacity.md`](../invariants/booking-dates-and-capacity.md).

### Asking to be let past a booking rule

Two club rules can be waived, one booking at a time, by a Booking Officer: a
**minimum stay**, and the requirement that an **adult member is present** for
non-member guests. When one of those stops you, the wizard and the edit screen
explain which rule it is and which nights it affects, rather than giving you a
bare refusal — and offer you a **Request Booking Officer approval** step.

You can do the whole thing yourself, without phoning the club.

#### Asking

The step appears in two places, and only when the rule that stopped you is one an
officer can actually waive:

- on the **booking wizard**, when you confirm a stay the club's rules do not
  allow; and
- on the **edit screen** of a booking you already have, when a change you try to
  save is stopped the same way.

It never appears for something nobody can waive — a **full** lodge, dates in the
past, a night you are already booked on, a guest you do not have authority over, or
a missing consent. Those need a different fix, and the screen says what it is.

Before you send it you see exactly what a Booking Officer will decide: the lodge,
the nights, every guest and the nights they are down for, the guest nights that
adds up to, the price for it, and the rule (or rules) you are asking to be let
past. **Say why you are asking** — that is required, and it is what the officer
reads first. The screen also states two things plainly, because both are true:
sending a request books nothing and confirms nothing, and Booking Officers allow
exceptions **at their discretion**, so there is no guarantee.

#### While you wait

- **Nothing is booked and nothing is charged.** If the request is on an existing
  booking, that booking is untouched until an officer says yes.
- **Beds.** A request for a booking you have not made yet **never holds beds** —
  availability is checked again when an officer reviews it, and a full lodge means
  it cannot be approved. A request to change an existing booking holds only the
  *extra* beds the change needs, and only if the club set the rule up that way; the
  screen tells you which of those applies to your own request rather than making a
  general promise. Approval can never put the lodge over capacity, and approval is
  not itself a reservation: the booking an approval creates holds no beds until you
  pay it.
- If nothing is held, the lodge can fill up before a decision. Your request then
  says **"Waiting — the lodge was full"** rather than sitting silently: an officer
  has looked, there was no room, and it stays open in case space frees up.

#### Tracking, withdrawing and replacing

**My Bookings** carries a **My booking-rule requests** section listing every
request you have raised — with the exact proposal, what you told the officer, what
the officer told you, whether any beds are held, and a link to the booking once an
approval has created one. Each one reads as one of:

| It says | It means |
| --- | --- |
| With the Booking Officer | Sent, nobody has decided yet |
| Waiting — the lodge was full | An officer tried to apply it and there was no room |
| Approved and booked | Approved *and* applied — there is a real booking behind it |
| Not approved | An officer decided against it, with their reason |
| Withdrawn by you | You closed it; nothing was booked or changed |
| Replaced by a newer request | You sent a corrected version instead |
| Lapsed | Nobody decided it before its hold ran out; you can ask again |

While a request is still open you can **Withdraw** it, or **Replace it with a
corrected request**. A request cannot be edited once it is sent — a Booking Officer
decides the exact proposal you submitted, so changing the dates, the guests or
anything else material means replacing it. Replace takes you back to the screen
that built it, and the old request is closed as replaced when the new one is sent.

Use **Replace** whenever you are switching an existing ask to different dates or a
different party. Sending a fresh request from the wizard instead does *not* close
the old one: the club caps you at one open request per identical proposal (new
bookings) and one per booking (changes), so two different date ranges are two live
requests, and an officer can approve them independently. That is two bookings, or a
new booking plus a change, and both are yours to pay for. If you already have one
open and just want to move it, replace it.

#### When it is decided

When an officer approves, the thing you asked for happens straight away: the
booking is created, or the change is applied. If it was a new booking, you get an
email telling you it was approved and what is left to pay — pay it from your
account, because the beds are not held until you do. Your request row says the same
thing: it reads "not holding any beds yet" until the payment lands, and then changes
to "holding its beds". If that booking is later cancelled, or lapses because it was
never paid, the row says it is no longer live and stops telling you to pay it. If it
was a change to a booking you already had, you get the
usual "your booking was changed" email and the row says the change has been applied.

If a Booking Officer says no, you get an email too: their reason, the nights it was
about, and confirmation that nothing was booked and any beds the request was holding
have gone back into the pool. You can then ask again with different dates or a
different party. Either way the officer's explanation is on your request in
**My booking-rule requests** as well as in the email.

## Troubleshooting

| Symptom | Why it happens | What to do |
| --- | --- | --- |
| The nights you want are greyed out or "Full" | No beds free on those nights | Pick other nights, or join the [waitlist](waitlist-and-offers.md) |
| You are quoted the non-member rate | Your membership subscription is not paid up | Check your [subscription status](your-account.md#account-information); pay it, then re-quote |
| "You already have a booking for these nights" | A member cannot double-book the same night | Open the existing booking from **My Bookings** and [change it](changing-or-cancelling-a-booking.md) instead |
| The stay is blocked by a minimum-stay rule | That period has a minimum number of nights | Extend your stay to meet the minimum, or use **Request Booking Officer approval** to ask to be let past it (see [above](#asking-to-be-let-past-a-booking-rule)) |
| You paid but the booking still says "Payment required" | The card step was closed before payment finished | Open the booking and use its **Complete Payment** card |
| Your non-member guests show as provisional | Your club runs the *Members First* policy (a name you never see in the wizard) and a hold applies to your stay | This is expected — their bed is charged/confirmed around the hold deadline; see [Paying](paying-for-your-stay.md#split-charges-for-non-member-guests) |
| **Book** refuses you because your subscription is unpaid, but you need a bed | The block stops you *starting* a booking; it does not stop you paying for one | Ask the club to make the booking for you and save it — it lands in your drafts and you pay it yourself (see [above](#a-booking-the-club-saved-for-you)) |
| A draft the club saved for you has disappeared | Unpaid drafts are removed 72 hours after they are saved | Ask the club to make it again, and either pay within three days or ask them to confirm it for you |

## Related links

- Back to the [Member & Guest Guide](README.md) and the
  [documentation hub](../README.md).
- Sibling guides: [Paying for your stay](paying-for-your-stay.md),
  [The waitlist & offers](waitlist-and-offers.md),
  [Changing or cancelling a booking](changing-or-cancelling-a-booking.md).
- Reference: the [booking lifecycle](../STATE_MACHINES.md#booking-lifecycle), the
  [booking dates & capacity invariants](../invariants/booking-dates-and-capacity.md),
  and the [UX flow map](../UX_FLOW_MAP.md).
