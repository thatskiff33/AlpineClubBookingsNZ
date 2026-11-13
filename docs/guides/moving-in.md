# Moving in from your old system

Audience: Adopter, Operator

## What it is

The order in which a club moves its people and money in from a previous
booking system or spreadsheet, the tool for each step, and how to prove that
nothing was lost or doubled. Nothing here has its own admin page. Each step
uses an existing admin area, linked where it applies.

Two things carry money over, and both are easy to get wrong:

- **credit members already hold** (an opening credit), which the
  [opening-credit batch](#6-credit-post-the-opening-credits) loads from one
  file, with one approval and a total you check first;
- **future stays members have already paid for**, which have no import yet. The
  [prepaid-booking recipe](#7-future-bookings-re-key-prepaid-stays-without-charging-twice)
  shows how to re-key them without billing anyone twice. The bookings import is
  tracked in
  [#5005](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5005).

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

If a batch was wrong, **Reverse batch** removes every credit in it, with a
reason. Members see "Opening credit reversed" in their credit history, never
your reason. Do it before members spend any of it: the reversal is refused, and
nothing changes, once any member has used part of their opening credit. More
detail is in [Refunds & Credits](refund-requests.md#post-or-reverse-opening-credits).

### 7. Future bookings: re-key prepaid stays without charging twice

Until [#5005](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5005)
adds a bookings import, a stay booked in the old system is re-entered with
[Book on Behalf](book.md). The danger is money. A stay the member **already
paid for** must not become a second bill.

**Unpaid stays** are ordinary bookings. Book them the usual way.

**Prepaid stays, whether or not your club uses Xero:**

1. Book on behalf of the member as usual, and choose **Card** as the
   **Payment method**. Do **not** choose Internet Banking: on that path, Xero
   raises an invoice the moment you confirm.
2. Click **Confirm Booking**, then **Create without emailing**.
3. On the new booking, open **Record manual payment**
   ([Record a payment made in cash or by an off-Xero bank transfer](payments.md#record-a-payment-made-in-cash-or-by-an-off-xero-bank-transfer)).
   Put the old system's reference in the note, and record it without emailing.
   The booking becomes **Paid** and holds its beds. Nothing is sent to Xero.

This is right because the money was received, and entered in the club's
accounts, before the move. A new Xero invoice would be a second debt for cash
the club already has.

**If an invoice was raised anyway** (for example, the booking went through on
Internet Banking), **Record manual payment** is refused. Settle that invoice
in Xero instead, against the payment the old system recorded, so Xero shows
it paid and not owed twice. If you are unsure, ask your treasurer which
account the old payment sits in before you do anything.

**If the price differs** from what the member paid: **Record manual payment**
always records the full amount owing. If they paid more, record it, then give
the extra back as a [credit adjustment](refund-requests.md#approve-or-reject-a-credit-adjustment).
If they paid less, do not record it yet: collect the difference first, or ask
your treasurer how to settle it.

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
- [ ] **Prepaid stays:** the number of future paid bookings, and the sum of
      the manual payments you recorded, equal the old system's prepaid list.
- [ ] **Xero (Xero clubs):** no new invoice exists for a stay or credit that was
      paid before the move.

## Settings reference

This guide has no settings of its own. Each step's settings are in its linked
guide.

| Tool | Where | Permission |
| --- | --- | --- |
| Import members from CSV, including **Membership Type** and **Family Key** | Admin → Members → Import CSV | Membership edit |
| Import Members from Xero | Admin → Xero Setup | Membership edit; Xero connected |
| Opening credits (import, post, reverse) | Admin → Finance → Refunds & Credits | Finance edit; finance view to see past batches |
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
| **Record manual payment** says there is a Xero invoice | The booking was confirmed on Internet Banking | Settle the invoice in Xero against the old payment; see step 7 |

## Related links

- [Run this for your club](../adopters/README.md): the adopter hub.
- [Members](members.md), [Membership Types](membership-types.md),
  [Family Groups](family-groups.md), [Subscriptions](subscriptions.md),
  [Xero](xero.md), [Book on Behalf](book.md), [Payments](payments.md),
  [Refunds & Credits](refund-requests.md).
- `INV-PAY-151` in [payment-and-settlement.md](../invariants/payment-and-settlement.md):
  the opening-credit contract.
- [#5005](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5005): the
  future-bookings import.
