# Moving in from your old system

Audience: Adopter, Operator

## What it is

The order in which a club moves its people and money in from a previous
booking system or spreadsheet, the tool for each step, and how to prove that
nothing was lost or doubled. Each step uses an admin area, linked where it
applies.

Two things carry money over, and both are easy to get wrong:

- **credit members already hold** (an opening credit), which the
  [opening-credit batch](#6-credit-post-the-opening-credits) loads from one
  file, with one approval and a total you check first;
- **future stays members have already paid for**, which the
  [paid-bookings import](#7-future-bookings-import-prepaid-stays) loads from
  one file at the price actually paid, with a preview and totals you check
  first, and without billing or emailing anyone.

## When you'd use it

- Your club is adopting the platform and has members, families, paid
  subscriptions, credit or booked stays in another system.
- You are the volunteer installing it, or the treasurer or booking officer
  checking that the move came out right.

Do the whole move on a test copy first if you can. Every step below can be
re-run on a fresh database until the totals match.

## Step-by-step

Work in this order. Each step relies on the one before: members need their
membership types to exist, families need members, and credit and bookings need
both.

### 1. Lodges and settings

1. Configure the club, its lodges, rooms and beds, seasons and rates. Use
   [Setup](setup.md) and [Lodges](lodges.md), following the
   [Implementation Guide](../IMPLEMENTATION_GUIDE.md).
2. Leave member emails off until the move is checked. Everything below lets you
   import without inviting anyone.

### 2. Membership types

1. Create every type your old system used, with the **same names**, in
   [Membership Types](membership-types.md). The member import matches a type by
   name, ignoring capitals and extra spaces. A type that is archived or missing
   blocks the row, so a typing slip cannot quietly leave a member on the wrong
   rate.

### 3. Members

Use **one** of these paths.

**Your club uses Xero.**

1. Open **Xero Setup** and run **Import Members from Xero**. It maps each Xero
   contact group to a membership type
   ([Set up mappings and import](xero.md#set-up-mappings-and-import-xero-setup)),
   and links dependants that share a parent's email into a family group.
2. Run **Scan for Duplicates & Family Groups** on the same page to catch the
   households Xero does not show.

**Your club has a spreadsheet or another system.**

1. Export your members to CSV and import it from **Admin → Members → Import
   CSV** ([Import members from CSV](members.md#import-members-from-csv)).
2. Add two columns to the file to save the type and family steps:
   - **Membership Type**: the type's name. Each new member gets that type for
     the current season, recorded as an import. An existing assignment is never
     changed.
   - **Family Key**: any short code you choose, such as the old system's family
     number. Every row with the same key becomes one family group, of at most
     10 people.
3. Up to 500 rows go in one file. A row matching an existing member is skipped,
   so you can split a large file and import it in parts.

### 4. Families

1. Open [Family Groups](family-groups.md) and check the groups the import
   created. Its **Suggestions** tab proposes groups for members still not in
   one. Add the rest by hand.

### 5. Subscriptions

1. **Xero club:** on [Subscriptions](subscriptions.md), click
   **Incremental Sync** ([Refresh paid status from Xero](subscriptions.md#refresh-paid-status-from-xero)).
   It marks paid every member whose subscription invoice Xero shows as paid.
2. **No Xero:** use **Mark as paid (manual)** on each paid member, choosing
   **Mark paid without emailing**
   ([Mark a member paid manually](subscriptions.md#mark-a-member-paid-manually)).

### 6. Credit: post the opening credits

Credit a member already held in the old system moves in as an **opening
credit**. It is recorded as already settled, so nothing is invoiced, charged
or emailed. It needs one approval, not the second admin a normal credit
adjustment needs, because you check the whole file against its total before it
posts. A row for yourself is refused: another admin posts your opening credit.

Before posting, finish the release upgrade and drain the old app and workers.
After any opening credit posts, a rollback must retain opening-credit lot and
accounting support; an older release can spend reversed lots or use the wrong
account.

1. Make a CSV with one row per member:
   - **Member ID** or **Email** to find the member. Add **First Name** and
     **Last Name** where two members share an email.
   - **Amount** in dollars (such as `45.50`), *or* **Amount Cents** (such as
     `4550`), but not both.
   - Optionally a **Description**. Without one, the credit reads "Opening
     credit carried over from the previous system".
2. Open **Admin → Finance → Refunds & Credits**. On the **Opening credits**
   card, click **Import opening credits** and choose the file.
3. Read the preview: matched members, rows to fix, the **total to post**, and
   every line. Fix any unmatched or invalid row in the file and choose it
   again. Nothing posts while a row needs fixing.
4. Compare the total with the old system's total credit owed to members. If
   they match, click **Post $X to N members**.

The same file can only post once. If anything in the file changes, it is a new
batch, and its total must be checked again. A member who already holds an
opening credit from an earlier batch that has not been reversed is refused, so
a corrected file cannot credit anyone twice: reverse the wrong batch first, or
leave those members out of the new file.

**Xero clubs: choose where spent opening credit is coded, before you post.**
Posting sends nothing to Xero. When a member later spends opening credit on a
booking, the app raises a Xero credit note against that booking's invoice for
the amount spent. The optional **Opening Credits**
mapping in **Xero Setup → Account mapping** decides which account that credit
note's line is coded to. It offers liability accounts only. Ask your treasurer
or accountant which of these fits your club:

- **The old credit is already in Xero**, for example as a balance in a member
  credits held account, or as open credit notes or overpayments on members'
  contacts. Set **Opening Credits** to the liability account that holds it, so
  spending the credit reduces that balance. If the old system left open credit
  notes or overpayments on members' contacts, settle with your treasurer how to
  deal with them before members spend anything, so the same money is not
  recorded in Xero twice: once by the old document and again by the app's.
- **The old credit was never recorded in Xero.** Leave **Opening Credits**
  unset. Spent opening credit is then coded to the **Hut Fee Refunds**
  account, exactly as it was before this setting existed. The setup checklist
  keeps listing the mapping as unset; for this case that is expected.

**The tax rate on the line.** While **Opening Credits** is set, the spent
opening credit is its own line on the credit note, sent with the Xero tax rate
you mapped to the **Exempt** tax category on the
[Tax categories card](xero.md#map-the-clubs-tax-categories-xero-setup). Every
other line on the note, and every line while **Opening Credits** is unset,
carries the same tax rate as the app's other credit-note lines, as before. A
club that is not GST-registered sends no tax rate on any line. Confirm the
treatment with your treasurer or accountant for the account you choose.

If your club is GST-registered, map the Exempt tax category on the Xero setup screen before you map the Opening Credits account; the app will not save the account, or send a spent opening credit, without it.

Three more things the app does to keep that line sendable:

- It will not save **Opening Credits** on an account another mapping already
  uses, such as **Hut Fee Refunds**. The message names the other mapping.
  Choose a liability account nothing else is mapped to.
- While **Opening Credits** is set and the club is, or is scheduled to be,
  GST-registered, **Clear** on the Exempt category is refused, including while
  Xero is disconnected. Unset **Opening Credits** first.
- If the Exempt rate stops being usable later (it is archived or changed from
  0% in Xero, or you connect a different Xero organisation), a spent opening
  credit is never sent with another rate. Its Xero operation waits, saying
  which category to map, and is tried again by itself every few minutes, so it
  goes once a Full Admin has mapped the category. On a card booking, the
  booking's Xero invoice operation fails instead; retry it from the **Xero
  Operations** list once Exempt is mapped. The Xero health check shows
  the problem while it lasts, and says to map Exempt or unset **Opening
  Credits**. The same happens if a club that set **Opening Credits** while it
  was not GST-registered schedules a registration later: the registration is
  saved as normal, so map Exempt before it starts. The app checks rates against its own copy of
  Xero's list, which can be up to 15 minutes old.

The Xero health check also reports **Opening Credits** stored on an account
another mapping uses. The save refuses that, so it can only appear if two
people saved mappings, or one saved while a configuration import ran, at the
same moment.

Changing the mapping affects only credit notes raised afterwards; notes already
in Xero are not changed.

If a batch was wrong, **Reverse batch** removes every credit in it, with a
reason. Members see "Opening credit reversed" in their credit history, never
your reason. Do it before members spend any of it: the reversal is refused, and
nothing changes, once any member has used part of their opening credit. More
detail is in [Refunds & Credits](refund-requests.md#post-or-reverse-opening-credits).

### 7. Future bookings: import prepaid stays

Future stays members **already paid for** in the old system come across with
**Admin → Bookings → Import Paid Bookings**. Each imported booking is stored as
**Paid** at the amount the club received, holds its beds, and is placed by the
normal bed allocation. No Xero invoice, card payment request or email is made,
because the money is already in the club's accounts. You need both **finance
edit** and **bookings edit** access to import or reverse.

**Unpaid stays** are ordinary bookings. Book them the usual way.

**The file.** One row per guest, for one lodge. Rows that share a **Booking
Ref** are one booking. The columns are Booking Ref, Lodge (needed when the club
has more than one active lodge), Owner Email, Owner First Name, Owner Last
Name, Guest Type (Member or Non-member), Guest Email, Guest First Name, Guest
Last Name, Age Group (for non-members: Adult, Youth, Child or Infant), Check
In, Check Out and Amount Paid, and optionally Nights and Notes. Your columns
can have other names: the import asks which column is which.

- **Check Out is the morning the guests leave**, not their last night. If you
  fill Nights, it must match.
- **Amount Paid** is dollars and cents. Either give every guest row its own
  amount, or give only the first row of a booking its total (the import shares
  it across the booking's guest-nights). A mix is refused. A blank amount is
  missing, not zero: a free stay says `0.00`.
- Members (the owner and member guests) are matched by email, first name and
  last name, as the member import matches them. Import members first (step 3).

**Import it:**

1. Open **Import Paid Bookings** and click **Import paid bookings**.
2. Choose the lodge and the file, then check the column for each item and the
   date format the file uses. Click **Preview**. Nothing is written yet.
3. Read the preview. It shows the bookings, guests, guest-nights and dollars
   that will import, the same for the refused bookings (grouped by reason), and
   the beds booked each night beside the lodge's capacity. **Will import plus
   refused equals the file**: compare the whole-file total with the old
   system's report before you go on. Beside each amount is what the app's
   rates would charge, as a typing check; a difference never refuses a row.
4. Click **Import**. The import works through the file in slices and shows its
   progress. If anything changed since your preview (another booking took the
   last beds, say), nothing is written and the new preview is shown: read it
   and import again.
5. The batch page then shows the imported and refused totals to check against
   the old records.

**Refused rows.** Each refused booking says why: a member not matched, a check
in before today, a member already booked that night, a night that would go over
capacity or is held for a whole-lodge booking, a Booking Ref already imported,
or a stay that breaks the club's own rules (no adult member hosting the
non-members, or children with no adult). A paid stay that breaks a club rule is
never let in under a reason: fix the row and import it again (a corrected file
is a new batch), or enter it by hand:

1. [Book on Behalf](book.md), choosing **Card** as the **Payment method**. Do
   **not** choose Internet Banking: on that path, Xero raises an invoice the
   moment you confirm.
2. Click **Confirm Booking**, then **Create without emailing**.
3. On the new booking, open **Record manual payment**
   ([Record a payment made in cash or by an off-Xero bank transfer](payments.md#record-a-payment-made-in-cash-or-by-an-off-xero-bank-transfer)),
   put the old Booking Ref in the note, and record it without emailing.

Book on Behalf prices the stay at today's rates, so **Record manual payment**
records that price, not what the member paid. Note the difference: if they
paid more, give the extra back as a
[credit adjustment](refund-requests.md#approve-or-reject-a-credit-adjustment);
if they paid less, ask your treasurer how to settle it. Until the stay is
keyed, its beds are not held. Part-paid bookings (a deposit with a balance
still owing) are refused for now with "part-paid bookings cannot be imported
yet"; enter them by hand.

**If an invoice was raised anyway** (a hand-keyed booking went through on
Internet Banking), **Record manual payment** is refused. Settle that invoice in
Xero instead, against the payment the old system recorded.

**Later.** An imported booking behaves like a booking paid in cash. Editing it
works as usual. If it is cancelled, by the member or an officer, the club's
cancellation policy applies to the imported amount and the refund appears
under **Money to settle**. Settle it one of two ways, at the same amount
([Pay back a refund for a cash booking](payments.md#pay-back-a-refund-for-a-cash-booking)):
pay it back by bank transfer and click **Mark paid back**, or click **Give as
account credit** to add it to the member's account for a later booking instead.
Credit emails the member and, on a club with Xero, raises the credit note every
account credit carries. Nothing is asked of Stripe.

**Reverse a batch.** If a batch was wrong, open it and click **Reverse batch**.
It first lists which bookings it will take back and which it keeps, and why.
Only bookings nobody has touched since the import are reversed: still paid, the
stay not started, not edited, no refund or refund task, no card payment and no
Xero link. Each is cancelled with its recorded payment taken back, nobody is
emailed and nothing is refunded. Touched bookings are kept; deal with each by
hand. A reversed Booking Ref can be imported again from a corrected file.

### 8. Check the totals against the old records

Before members are invited, compare each total with the same figure from the
old system. Stop at the first one that differs, and find the difference before
going on.

- [ ] **Members:** the import's created count, plus the rows it skipped as
      existing, equals the old member count.
- [ ] **Membership types:** the import's "Membership types assigned for this
      season" equals the count of old members who had a type. Every row
      reported as not assigned has been fixed by hand.
- [ ] **Families:** the import's "Family groups created" equals the number of
      distinct family keys with members in them.
- [ ] **Subscriptions:** the paid count on Subscriptions equals the old system's
      paid count for this season.
- [ ] **Credit:** the posted batch total on the **Opening credits** card equals
      the old system's total credit owed to members, to the cent.
- [ ] **Prepaid stays:** each import batch's imported plus refused totals
      (bookings, guests, guest-nights, dollars) equal the old system's prepaid
      list, and every refused booking has been fixed and imported again, or
      entered by hand.
- [ ] **Xero (Xero clubs):** no new invoice exists for a stay or credit that was
      paid before the move.
- [ ] **Opening Credits mapping (Xero clubs):** set to the liability account
      that holds the old credit, or left unset because the old credit was never
      in Xero, as your treasurer decided. Where the old credit is in Xero, no
      open old-system credit note or overpayment still duplicates a posted
      opening credit. If it is set and the club is GST-registered, the
      **Exempt** tax category is mapped.

## Settings reference

This guide has no settings of its own. Each step's settings are in its linked
guide.

| Tool | Where | Permission |
| --- | --- | --- |
| Import members from CSV, including **Membership Type** and **Family Key** | Admin → Members → Import CSV | Membership edit |
| Import Members from Xero | Admin → Xero Setup | Membership edit; Xero connected |
| Opening credits (import, post, reverse) | Admin → Finance → Refunds & Credits | Finance edit; finance view to see past batches |
| Import paid bookings (preview, import, reverse a batch) | Admin → Bookings → Import Paid Bookings | Finance edit and bookings edit; finance view and bookings view to see past batches |
| Record manual payment | The booking's **Admin tools** card | Finance edit |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A member import row says the membership type is not active | The type is misspelt, missing or archived | Create or restore the type with that exact name, or fix the cell |
| A member import row says a family has too many members | More than 10 rows share one family key | Split the family into two keys, or correct the key |
| A member was imported but "membership type not assigned" | The season save was refused for that member, or the member is cancelled | Set the type from the member's page; the row says why |
| An opening-credit row is **Unmatched** | No member has that ID or email, or two do and the name does not narrow it | Fix the email or ID, or add First Name and Last Name |
| "This file has already been posted" | The same rows were posted before | If that batch still stands, nothing to do. If it was reversed and you want it again, change the file (such as a description) so it is a new batch |
| An opening-credit row says the member already has an opening credit | An earlier batch that has not been reversed credited them | Reverse that batch, or leave the member out of this file |
| **Reverse batch** is refused | A member has used some of their opening credit, or has had any credit deducted since the batch posted | Correct that member with a credit adjustment instead |
| Saving the account mapping says **Opening Credits** cannot use the same Xero account as another mapping | The account you chose is the one that mapping uses, by choice or by default | Choose a liability account no other mapping uses, or change the other mapping first |
| Saving the account mapping says to map the **Exempt** tax category first | The club is, or is scheduled to be, GST-registered, and Exempt has no usable Xero rate | A Full Admin maps **Exempt** on the **Tax categories** card; then save again |
| **Clear** on the Exempt tax category is refused | **Opening Credits** is set, so spent opening credit needs the Exempt rate. Xero being disconnected does not lift this | Unset **Opening Credits** on the account mapping first. If Xero is disconnected, connect it first: the mapping panels show only while connected, and an Exempt mapping chosen in a different Xero organisation can then be cleared |
| The Xero health check says **Opening Credits** cannot use the same Xero account as another mapping | Two saves of the account mapping, or a save and a configuration import, landed at the same moment, so the check each one made did not see the other | Choose a liability account no other mapping uses, or change the other mapping, and save |
| A Xero operation says the Exempt tax category is not mapped, or its rate cannot carry it | The Exempt rate was archived or changed in Xero, a different Xero organisation was connected, or the club registered for GST later | A Full Admin maps **Exempt** again. A waiting operation then runs by itself within a few minutes; if a card booking's invoice operation failed with this message, retry it |
| **Record manual payment** says there is a Xero invoice | The booking was confirmed on Internet Banking | Settle the invoice in Xero against the old payment; see step 7 |
| The paid-bookings preview says a member is not matched | No member has that email with that first and last name, or more than one does | Fix the row, or the member's record, and preview again |
| **Import** says the preview has changed | Something moved between your preview and the import, such as a booking taking the last beds | Read the new preview; nothing was written. Import again |
| **Import** says the batch was reversed | That exact file was imported and then reversed | Correct the rows; a changed file is a new batch |
| The import stopped part-way | The connection dropped or the server stopped | Upload the same file and import again: bookings already imported are not imported twice |
| **Reverse batch** keeps a booking | It was edited, cancelled, refunded, paid by card or linked to Xero since the import, or its stay has started | Deal with that booking by hand |

## Related links

- [Run this for your club](../adopters/README.md): the adopter hub.
- [Members](members.md), [Membership Types](membership-types.md),
  [Family Groups](family-groups.md), [Subscriptions](subscriptions.md),
  [Xero](xero.md), [Book on Behalf](book.md), [Payments](payments.md),
  [Refunds & Credits](refund-requests.md).
- `INV-PAY-162` in [payment-and-settlement.md](../invariants/payment-and-settlement.md):
  the opening-credit contract; `INV-PAY-161` and `INV-PAY-164` the paid-bookings
  import and its reversal.
- [The paid-bookings import engine](../design/booking-import.md), for
  developers.
