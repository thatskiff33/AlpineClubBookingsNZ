# Email Messages

Audience: Operator

## What it is

Two things in one page: the **shared email variables** every automated email
uses (your club name, sender display name, support and contact addresses, public
URL), and an editor for the **wording of each audited email template** — its
subject and body, with token chips, a live preview, and a per-template restore.
Find it at **Admin → Setup & Configuration → Notifications & Email → Email Messages**
(`/admin/email-messages`). It has no direct sidebar entry — open it from the
**Email Messages** card on the Notifications & Email hub.

This is the *system* email editor. The member-facing booking, payment, and
cancellation copy lives on the separate [Booking Messages](booking-messages.md)
page. Email Messages are edited under the **support** ("Support & System")
permission area; a view-only support role can read but not save.

## When you'd use it

- Your club name, sender display name, support address, or public URL changed and
  every email needs to reflect it.
- The wording of a specific system email (password reset, application approved,
  a booking notice) needs to change from the built-in default.
- You want to preview exactly what a template renders — with real sample values
  substituted for its tokens — before it goes to members.

## Step-by-step

### Update the shared email variables

1. Open **Email Messages**. The top card holds the shared settings.

   ![Email Messages: the shared email-variable fields above, then the Template dropdown with token chips, subject, body, and Save Template / Preview / Restore Default](../images/admin/admin-email-messages.png)

2. Edit any of **Club name**, **Bookings name**, **Sender display name**,
   **Support email**, **Contact email**, or **Public URL**, then click
   **Save Email Settings**. These feed the `{{CLUB_NAME}}`, `{{SUPPORT_EMAIL}}`,
   `{{BASE_URL}}` and related tokens in every template. (Lodge name, travel note,
   and door code are no longer set here — a single-lodge club edits them on
   **Club Identity** under [Site Appearance & Content](appearance.md); a
   multi-lodge club sets them per lodge under **Setup → Lodges** (see
   [Lodges](../multi-lodge/README.md)).)

### Edit a template's wording

1. Choose a template from the **Template** dropdown. The badges show its
   audience (member/admin), key, a one-line trigger summary, and how often it
   sends.
2. Insert any of the **Tokens** chips into the **Subject** or **Body**. A
   highlighted token is **required** — the save is rejected if you remove it
   (for example the sign-in `{{token}}` in a magic-link email).
3. Click **Preview** to render the subject and body with sample values, then
   **Save Template**. Use **Restore Default** to drop your override and return to
   the built-in wording.

### There is no "only if" — write lines that always read correctly

The body is plain text with token substitution and **nothing else**. There is no
`if`, no conditional, no way to show a line only when a value exists. A token
whose value is not applicable to a particular send simply renders as **nothing
at all** — so a line you write as `Door code: {{doorCode}}` prints a bare
`Door code:` to every member staying at a lodge that has no door code.

That is why several tokens are **pre-composed whole lines** rather than bare
values: `{{doorCodeNote}}`, `{{reasonNote}}`, `{{adminNoteLine}}`,
`{{reviewNoteLine}}`, `{{committeeNote}}`, `{{amountRecordedNote}}`,
`{{promoSummary}}`, `{{creditNote}}`, `{{checkoutChoreNote}}`,
`{{provisionalGuestsNote}}` and their
siblings each render the **entire** line — label, value and the blank line after
it — or nothing whatsoever. Put one of those tokens on its own, with no label of
your own in front of it, and the email reads correctly whether or not the value
exists.

A second, related pair works the other way round: **`{{rebookLabel}}` and
`{{rebookPath}}`** in the **Booking Update** (bumped) message. That email goes to
two very different people — a club member whose pending booking lost its beds,
and the organisation or school contact whose booking came from a public booking
request. The member can sign in and book again; the contact has no login at all,
so sending them to the member booking page would land them on a sign-in screen
they can never get past. The two tokens carry the caption and the destination, so
the line `{{rebookLabel}}: {{BASE_URL}}{{rebookPath}}` reads
`Book Again: …/book` for a member and `Contact the Club: …/contact` for a
contact who cannot sign in. Keep them together on one line, and keep
`{{BASE_URL}}` between them, or the link will not point anywhere useful.

Two consequences worth knowing:

- **Never write a label in front of a `…Note` / `…Line` token.** Writing
  `Admin note: {{adminNoteLine}}` reintroduces the dangling label the token
  exists to prevent.
- **Never annotate a body with instructions to yourself.** Text such as
  `[only when a door code is set]` is not understood by anything — it is
  printed verbatim to the member. Older built-in wording carried such notes;
  they were all removed in v0.13, the build refuses any that come back, and
  **Save now refuses square-bracketed text in an override** too. The notes the
  project itself shipped were also **stripped out of every saved customisation
  on upgrade** — matched as the exact strings we shipped, never anything that
  merely looks like one, so your own bracketed wording survives even when it
  reads like ours (`[when you are 30 minutes away]` is yours, and it stays),
  and every message changed is recorded in the audit log with the whole before
  and after so you can see what happened. **Every message that was changed is
  also named on this page**, with the notes removed and the lines they sat
  beside, because one of our notes was sometimes the only thing marking a line
  as conditional — read those lines and press Save when you are happy, which
  clears the notice. Square-bracketed
  text your own admins wrote is deliberately **not** deleted for you: a warning
  at the top of this page names each template still carrying some, so open it,
  delete the bracketed text and save, or reset it to the corrected default.

### When your saved wording falls behind the built-in wording

Saving your own copy of a message freezes it. If a later release improves the
built-in wording, your copy keeps sending as you wrote it — which is the point.
Occasionally, though, the built-in wording changes because the message now has
to tell the recipient something it did not before, and a frozen copy quietly
stops saying it.

The page handles the two situations differently, on purpose.

- **Your copy is missing something the message must say.** A warning at the top
  names each affected template and the token to add back. The commonest case is
  a booking confirmation saved before the promo explanation moved into
  `{{promoSummary}}`: it now shows a subtotal and a total with nothing in
  between to explain why they differ. Wording of your own that carries the same
  information counts, so a hand-written `Discount ({{promoCode}}): -{{discount}}`
  line does satisfy this particular requirement.
- **A line of your copy goes out with nothing after the label.** A warning names
  the exact lines and quotes them as a member would read them when the value
  behind them is empty. This is the companion to the point above, and the same
  hand-written discount line is the worked example:
  `Discount ({{promoCode}}): -{{discount}}` is fine on a booking that had a
  discount, but on an ordinary booking it sends `Discount (): -`, and on a promo
  code that **raised** the price it sends `Discount (PEAK): -` to a member who
  was charged more. The old built-in wording carried a note in square brackets
  beside those lines saying when they applied; the notes were never understood
  by anything and are now removed, so this warning is what tells you instead.
  The fix is to delete the line, or replace it with `{{promoSummary}}`, which
  renders the whole explanation or nothing at all.

  This particular check is **deliberately cautious**, and it is worth knowing
  which way it errs. It empties every value that any send could leave empty, all
  at once. Some of those values are two halves of one story and are never both
  empty in reality — an amount already paid and an amount still owing, for
  instance: a booking is unpaid, or paid, or part-paid, and the part-paid case
  fills in both. A line you wrote that puts both on one line can therefore be
  listed here when it is perfectly fine. The check never misses a genuinely
  broken line; it can name one that is not. Read each quoted line before you
  change it.
- **An upgrade removed one of our own notes from your copy.** Older built-in
  wording carried square-bracketed notes, and a release removed them from every
  saved copy because they were being emailed word for word. A warning names each
  message that was changed, lists the notes removed, and quotes the lines they
  were attached to. Those notes were sometimes the only thing marking a line as
  conditional — `Payment has been processed successfully.` was one of ours, with
  `[only when the booking is already paid]` beside it — so the line now sends
  every time. Nothing about your own wording was changed, and the whole previous
  copy is kept in the audit log. Read the quoted lines, edit anything that no
  longer reads correctly, and press **Save Template**; saving clears the warning
  whether or not you changed anything.
- **Your copy simply reads differently.** That is stated as a plain fact under
  the template you have open, with no warning attached, because a customisation
  differing from the built-in wording is exactly what you asked for.

In every case **Show differences** lays your saved copy beside the current
built-in wording line by line — red is yours, green is the built-in — so you can
decide whether to patch your own words or press **Restore Default**, knowing
exactly what you would be giving up. Nothing is ever changed for you here.

Two things to know about that comparison. It shows the copy that is currently
**saved**, not what is in the editing boxes, and it says so when you have
unsaved edits — save first if you want to compare what you have just typed. And
**Restore Default deletes your wording outright**: it asks you to confirm, and
after that the only copy is the one written to the audit log — your subject and
body in full, not an extract — which needs someone with database access to read
back. One caveat on "in full": the audit log masks any **line** that reads like
it carries a password, token or card number, so the built-in password-reset
line `Reset Password: {{BASE_URL}}/reset-password?token={{token}}` is stored as
`Reset Password=[REDACTED]` and would have to be retyped. Every other line is
kept exactly as you wrote it. If you are unsure, copy your wording somewhere
safe first.

For the same reason, **each template covers exactly one outcome.** Where a
message could go two ways there are two templates to edit, not one with a
condition inside it — `Refund Request Approved` and `Refund Request Declined`,
`Booking Review Approved` and `Booking Review Rejected`, and so on. Edit both if
you want both reworded; editing only one leaves the other on its built-in text.

> **Upgrade note (v0.13).** The single *Refund Request Resolved* template was
> split into **Refund Request Approved** and **Refund Request Declined**. If you
> had customised the old one, its wording said "approved" and was also being
> sent to members whose appeal was **declined**. Your old customisation is not
> carried over — both new templates start from the corrected built-in wording,
> and the leftover row is reported at the top of this page as a stale override
> needing cleanup. Re-apply your wording to whichever of the two you want to
> change.

## Settings reference

Shared email variables (top card):

| Field | What it controls | Token it feeds |
| --- | --- | --- |
| Club name | The club's display name | `{{CLUB_NAME}}` |
| Bookings name | The booking-system name | `{{CLUB_BOOKINGS_NAME}}` |
| Sender display name | The "from" name on outbound email | `{{CLUB_EMAIL_FROM_NAME}}` |
| Support email | The support address shown to members | `{{SUPPORT_EMAIL}}` |
| Contact email | The general contact address | `{{CONTACT_EMAIL}}` |
| Public URL | The site's base URL for links | `{{BASE_URL}}` |

Per-template editor:

| Rule | Detail |
| --- | --- |
| Allowed tokens only | Only the chips shown for that template are accepted; unknown `{{tokens}}` are rejected |
| No conditional syntax | Tokens are substituted, nothing more. A value that does not apply renders as nothing — use the pre-composed `…Note` / `…Line` chips for anything optional, and never write `[only when …]` guidance into a body |
| Required tokens | The highlighted chip(s) must stay in the body — removing an essential bearer token (e.g. a `/pay/<token>` or sign-in link), the lodge access details, or the promo explanation on a payment confirmation is refused. A sentence under the chips names the required tokens, and any older token that satisfies the same requirement instead (`{{promoSummary}}` **or** `{{promoAdjustment}}`/`{{discount}}`; `{{doorCodeNote}}` **or** your own label around `{{doorCode}}`) |
| Subject safety | Sensitive token values (e.g. raw tokens) are never allowed in a subject line |
| Override vs default | Saving stores an override; **Restore Default** deletes it and reverts to the built-in text |
| Stale overrides | A count is shown if any stored overrides reference templates that no longer exist (a data-cleanup task) |
| Retired tokens | A warning names any saved override still using a token its template no longer offers. A token that is not supplied renders as **nothing**, so the line it sits on can go out empty — open the named template, swap the old token for the chips now shown, and save (or reset it to the current default) |
| Audit | Template edits are audited (who changed what, when) |
| Authorized booking link | Concrete-booking templates offer optional `{{bookingUrl}}`. It renders the encoded booking-detail URL only for a signed-in owner, linked member, or bookings-view admin whose direct/inherited mailbox still matches the delivery address. The whole line, plus any old concrete booking href in the delivered copy, disappears for public/non-login, aggregate, stale-mailbox, or unauthorized recipients; saved override wording and bearer action links remain unchanged |
| Pre-composed blocks | Some tokens hold a whole sentence or block the system builds for you. You can move one or leave it out, but you cannot reformat what is inside it — see below |

### Tokens that hold a whole block, and what that means for you

The body editor substitutes tokens and nothing else — there are no "if" tests and
no repeating rows. So wherever a message has to say something only *sometimes*,
or has to list *several* things, the system builds that whole piece of text and
hands it over as one token. You will see these on the member-guest emails and on
several booking emails; they are named `...Note` or `...Line`.

Two consequences worth knowing before you edit one:

- **Leave a block token on a line of its own.** Do not put a label of your own in
  front of it. When there is nothing to say the token comes through empty, and a
  label you added would be left stranded above nothing.
- **The party listing on the member-guest emails is one block, heading included.**
  `{{partyListNote}}` produces the "Everyone on this booking" heading and the list
  of names together. You can move that block or leave it out; you cannot change
  how each guest's line is laid out, because the editor has no way to repeat a
  row. If a club needs a different per-guest layout, that is a change to the
  template engine, not something an override can do.
- **The pre-arrival reminder's chore sentence only appears for clubs that run a
  roster.** `{{checkoutChoreNote}}` on **Pre-arrival Information** produces the
  whole sentence — that guests are on the chore roster on the morning they check
  out, and should talk to the hut leader beforehand if they plan to leave early —
  when the **Chores** module is switched on under **Admin → Setup → Modules**, and
  **nothing at all** when it is off. That is deliberate: the chores module starts
  off, and a club that keeps no roster must not tell its members to go and find a
  hut leader about one. Put it on a line of its own and never type a label in
  front of it. Its neighbour `{{expectedArrivalNote}}` works per booking rather
  than per club: it prints the member's expected arrival time as a whole line when
  they recorded one, and nothing when they did not. That time is information for
  the hut leader only — it changes no date, no charge and nobody's chore.
- **Never type a currency sign in front of a money token.** Tokens such as
  `{{consequenceNote}}` already contain the formatted amount, so a `$` in front
  of one prints `$$48.00`. For the same reason, never type a `-` or `+` in front
  of `{{promoSummary}}`, `{{promoAdjustment}}` or `{{creditNote}}` — each already
  carries its own sign, and Save refuses a body that does.
- **The booking confirmation explains account credit for you.**
  `{{creditNote}}` produces the two reconciling lines a member needs when they
  paid part of a stay from their account credit — `Account credit applied:
  -$120.00` and `Paid by card: $180.00` (or `Paid by bank transfer` / `Paid by
  cash or bank transfer`, matching how the club was actually paid; or
  `Nothing more to pay: $0.00` when the credit covered the whole stay and no
  money changed hands at all) — and **nothing at all** for the great majority of
  bookings, which use no credit.
  `Total Paid` stays the booking's full price above it, so the three figures add
  up. The built-in wording already carries this inside `{{paymentOutcome}}`; you
  only need `{{creditNote}}` if you write your own money lines out of
  `{{totalPaid}}` and friends — and if you do, include it, or a member charged
  $180.00 will read `Total Paid: $300.00` with nothing to explain the difference.
- **A confirmation that still owes money points at the invoice, not at its own
  total.** When a booking is confirmed with payment still owing (a member
  whole-lodge approval), `{{paymentDueNote}}` — carried inside
  `{{paymentOutcome}}` — ends with *"If the invoice asks for a different amount
  — for example because the club has put account credit you hold towards it —
  please transfer the amount the invoice shows."* The `Total Due:` figure is the
  booking's own price; the invoice is a separate document you can adjust in
  Xero, so the email tells the member to follow the invoice rather than the
  email. The sentence is conditional on purpose — for most members the two
  agree — and it states no second amount. Where the booking system holds **no**
  account credit against the booking, which is every unpaid confirmation it
  sends today, nothing puts a member's credit towards such an invoice for you;
  if you want that, do it in Xero, and the member has already been told to pay
  what the invoice asks. (Where it **does** hold credit against the booking,
  that allocation is made for you — see the next point — so doing it by hand as
  well spends the member's credit twice.) No new token was
  added, so if your wording keeps `{{paymentOutcome}}` (or uses
  `{{paymentDueNote}}` on its own) the sentence arrives with no edit at all — but
  the same caveat as `{{creditNote}}` above applies: a body that writes its own
  money lines out of `{{totalDue}}` and friends and carries neither of those two
  tokens has never told an unpaid member how to pay, and still does not. Add
  `{{paymentDueNote}}` to such a body. It renders only on the unpaid
  confirmation and is empty everywhere else, so put it on a line of its own — a
  label typed in front of it ("Payment: `{{paymentDueNote}}`") would leave a bare
  `Payment:` on every confirmation that is already paid, and the editor now warns
  you about exactly that.
- **…unless the club's own records already show credit against that booking, in
  which case it does the sum for the member.** If account credit has been put
  towards the booking, `{{paymentOutcome}}` renders three lines that add up —
  `Booking Total: $300.00`, `Account credit applied: -$120.00`,
  `Total Due: $180.00` — and `{{paymentDueNote}}` asks for the `$180.00`,
  explains where it came from, and asks the member to transfer that and tell the
  club if their invoice says something different. `{{totalDue}}` carries the
  netted `$180.00`, so a body that writes its own money lines gets the right
  figure without you touching it; `{{creditNote}}` stays empty, because that
  block explains a booking that has already been paid for. The invoice itself is
  netted for you at the same time (the club's own credit records are what drive
  that allocation), so there is nothing to do in Xero by hand — doing it anyway
  spends the member's credit twice.

  Three things are worth knowing. The figure comes from the booking system's own
  credit records, so the email never waits on your accounting system — and if
  the invoice has not caught up yet, the member is told to pay the email's
  figure rather than a **larger** invoice. That is the opposite of the
  conditional sentence above and is deliberate; it is also one-directional, so
  an invoice asking for **less** is still the one the member pays, and either
  way they are asked to tell the club. Next, the two edge cases: credit that
  covers the booking exactly renders the same three lines ending in
  `Total Due: $0.00` and asks for nothing, and credit **larger** than the
  booking's price makes the email name no figure at all — it states the
  `Booking Total`, leaves `{{totalDue}}` empty, asks the member to wait while
  the club works out what is left to pay, and logs it for an admin. A booking
  with no credit against it gets the conditional sentence exactly as before.
  Finally, if you invoice by hand because the Xero module is off, the
  "Whole-lodge booking needs a manual invoice" alert quotes the netted amount
  the member was asked for — invoice that, not the booking's price.

### Consent emails ignore a member's notification preferences

The six member-guest emails — the consent request, the "you have been added"
notice, the "you are no longer on that booking" notice, the outcome notice to
whoever made the booking, the notice that somebody in the family answered on a
member's behalf, and the lapse notice —
deliberately do **not** follow a member's own notification-category preferences,
and they are not affected by the per-action "email the member" choices on admin
screens. Being asked whether you agree to be on somebody's booking is not a
preference: a member who had muted a category would never be asked, and would
then quietly come off the booking days later without ever having heard about it.

You can still change their wording here like any other template. A booking that an
admin has silenced does withhold them, along with everything else about that
booking.

**Three of the six are one template doing several jobs**, because the difference
between the jobs is one sentence rather than a different message:

- **"You have been added to a lodge booking"** covers a club that adds member
  guests without asking, an officer adding somebody on a member's behalf, and a
  place created from an approved booking request. The opening sentence says
  which, so an admin editing the wording edits one body rather than keeping three
  near-copies in step.
- **"You are no longer on that lodge booking"** (#2309) covers a request called
  off before anybody answered, a member guest taken off a booking, and a
  booking-request booking that was re-arranged so somebody else has the place.
  It is *not* sent when a request simply lapses — that has its own lapse notice —
  and it is not sent to a member who took themselves off.
- The **removal advice** at the foot of the added notice is composed from the
  same rule the server enforces, so it never offers a "take yourself off" link
  the server would refuse. On a booking priced by hand it names the club as the
  only remedy, because the person who made the booking cannot help.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only | Your role has support view, not edit | Ask a full admin for Support & System edit access |
| Save is rejected | You removed a required token, used an unknown token, or put a sensitive token in the subject | Read the reason in the error — it names what the email must show and which tokens do it. Re-add the highlighted token (or one of its listed alternatives); use only the listed chips; keep tokens out of the subject |
| A token shows literally to members | It is misspelled or not allowed for that template | Use the exact chip from the **Tokens** list |
| A line reads "Admin note:" with nothing after it | You wrote your own label in front of a value that was empty for that send | Use the matching pre-composed chip (`{{adminNoteLine}}`, `{{reasonNote}}`, `{{doorCodeNote}}` …) on its own line instead |
| I want the original wording back | An override is in place | Click **Restore Default** for that template |
| The change didn't reach a lodge-specific value | Lodge name/travel note/door code are per-lodge now | Set them in [Lodges](../multi-lodge/README.md), not here |
| An email's colours are the platform default rather than our brand | Colours come from [Site Style](site-style.md), not from this page, and that style could not be read when the message was built | Nothing here needs re-saving. Check the server log for the warning that names the saved style as unreadable, and the database's health — see [Site Style](site-style.md) |
| No email is going out at all, from anywhere | This installation is not the club's live site, or nothing has told it which it is | Nothing on this page is wrong. Open [Environment](environment-role.md): a **copy** deliberately sends nothing, and an installation nobody has declared holds mail back until you declare it. That page also shows how much has been held back |
| Nothing is going out and this IS the live site | The deployment declares itself the live site *and* declares a local capture mailbox, which cannot both be true | Remove `USE_LOCAL_CAPTURE` (or set it to `false`) and set `USE_AWS_SES` or `USE_SMTP_RELAY` instead. Most held-back messages then go out by themselves; ones carrying a sign-in link, a door code or a payment link keep no stored copy and are listed for a manual re-send — see [Environment](environment-role.md) |

## Related links

- Back to the [documentation hub](../README.md).
- Hub: [Notifications & Email](notifications.md).
- Sibling guides: [Delivery Rules](notification-rules.md),
  [Recipients](notification-recipients.md),
  [Booking Messages](booking-messages.md) (member-facing booking copy),
  [Email Deliverability](email-deliverability.md).
- Reference: the authoritative template catalogue, approved tokens, and
  subject/body safety rules in
  [`../../src/lib/email-message-registry.ts`](../../src/lib/email-message-registry.ts).
