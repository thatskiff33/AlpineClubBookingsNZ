# Changelog

All notable public reference-release changes should be recorded here.

## Unreleased

<!-- changelog-pointer-note:start -->

Entries for the next release are written as one file per pull request in
[`changelog.d/`](changelog.d/README.md), not added here by hand (#2452);
`scripts/release/compile-changelog.mjs` folds them into a version section when a
release is cut. Any entries still listed below were written before that change
and are folded in the same way.

<!-- changelog-pointer-note:end -->
- **Finding the right parent again: the Link Parent search lists adults first,
  and says when it ran out of room (#2425).** Recording a parent of any age was
  the right call — a 16 or 17 year old can genuinely be a parent — but it had a
  consequence nobody meant. The search shows eight people at a time, ordered by
  surname then first name, so a family who all share a surname could put their
  **children in all eight slots** and leave the adult the admin was actually
  looking for off the list entirely, with nothing on screen to say the list had
  been cut short. On a big family, the parent was simply unreachable.

  The list now puts **the grown-ups at the top and children and youth last**.
  This changes the ORDER and nothing else: exactly the same people are offered as
  before — any active, non-archived member of any age who is not an organisation
  or school account — and the younger candidates follow immediately below. Adults
  come first, and so does a member whose membership type makes them age-exempt
  (an honorary or life member, who carries no age tier at all): they are
  grown-ups too, and sorting them in among the children would have left the
  problem unfixed for the very families it was reported on. The dialog now says
  so ("adults are listed first, children and youth last"), so the order does not
  read as a fault. Who may be recorded as a parent, and who the club emails about
  a dependent (always an adult), are both completely unchanged.

  When more people matched than the list can show, it now says **"Keep typing to
  narrow this down."** underneath — the same sentence the booking screens use
  when a member search is cut short, so the product says one thing in one voice.
  The hint appears only when the list really was truncated, never under a
  complete one, and never when nothing matched at all.

- **The cancellation queue stops spending Xero API calls on questions nobody can
  act on (#2402).** Opening **Admin → Members → Cancellation Requests** asked
  Xero, for every participant on the page, whether that member's contact still
  owed the club money — on every page load, every filter change and every
  refresh, whoever was looking. Xero meters those calls daily, and most of them
  bought nothing: they were asked for participants who had already been rejected
  or cancelled, and for admins whose role cannot approve a cancellation at all.

  The check now runs only where its answer can still change what somebody does:
  for an admin whose role has **edit** access to membership — the same permission
  the Approve and Reject buttons need — and for a participant that is genuinely
  still awaiting approval, meaning the request is open, the member has confirmed,
  and the membership has not since been deactivated or cancelled.

  Only the Xero half is affected. Outstanding **bookings and guest appearances**
  come from ordinary database reads that cost nothing external, so they are still
  loaded and still shown to everyone, including view-only admins.

  There is a real cost to this and it was accepted deliberately: a **view-only**
  membership admin is no longer told that money is owing on a participant. They
  are not left to guess. A request holding affected rows now carries a short blue
  note — *The money-owing check was not run for … below* — with each affected
  member marked, because an absent warning panel and "nothing is owing" look
  identical on screen and only one of them would have been true. The note says
  plainly that the question was not asked, not that the answer was no.

  The **Approve** button now follows the same rule the server does, rather than
  the looser approximation it carried before. A membership deactivated after its
  cancellation was raised no longer offers an Approve that the server would
  refuse — the button is disabled and a line beneath it says why. That is what
  makes the saving safe: a row is only left unchecked when an approval of it
  would have been refused anyway.

  Nothing about approving itself changed. Pressing **Approve** still asks Xero
  live, every time, for everyone, still refuses while anything is owing, and
  still refuses when Xero cannot be asked at all — as does the second check made
  immediately before a Xero contact is archived.
- **A club's website now says "not ready yet" until its setup is finished,
  instead of quietly answering as though everything were fine (#2420).** Before
  a club saves its site style for the first time, every public web address shows
  a "Site setup in progress" holding screen. That screen was being handed over
  with the hidden status line that means "here is your page" — so a search
  engine could start listing a club's half-built site, and an uptime check would
  report a site that has never opened as healthy. Every public address now
  carries the status that means "temporarily unavailable, come back shortly",
  along with a stated wait, which is what search engines and monitoring tools are
  built to act on.

  Every public address is treated the same way while setup is unfinished — the
  home page, a page the club has already written, and a mistyped address all get
  the same holding screen. Until the club has chosen how its site looks, none of
  it is ready to be seen or listed, and answering differently for pages that
  exist would tell anyone probing a half-built site exactly which pages are
  there.

  Nothing an administrator needs in order to finish setup is affected: the admin
  area, the site style wizard itself, the login and password pages, the member
  and lodge areas, the lobby display, and the data addresses the app talks to all
  behave exactly as before. Once setup is complete, so does the public website —
  this changes nothing at all for a club already running. The site opens within
  about fifteen seconds of the setup being saved.

  Reviewing this work turned up four further problems, all fixed here. An
  unlaunched club was still naming its pages: the page titles and summaries that
  browsers and search engines read are assembled separately from the page itself,
  so they were still being sent even though the page was not — enough for a
  stranger to list every page an unfinished site had, including ones the club had
  written but deliberately not published. Every public page now gives the same
  neutral "site setup in progress" title until the club opens, whether the page
  exists or not.

  A club's optional custom styling could also be crafted to break out of the
  styling block and run as page code, because the check that removes the
  dangerous sequence only looked once and a carefully split sequence reassembled
  itself behind it. It now repeats until nothing is left to find. This one
  predates the change — the ordinary website had the same exposure — so it is
  fixed for every page that uses custom styling, not just the new one.

  A handful of addresses that merely began with a reserved word (`/apiary`,
  `/logo.pngs`) were skipping the check entirely and still answering as though
  the site were open; they no longer do, and as a side effect they now receive
  the same browser-security headers as every other page. And a brief database
  interruption on a long-running club could make the site claim it was still
  being set up, then leave that claim in visitors' browsers for a minute — the
  club's own pages now tell the difference between "not set up" and "could not
  check".

- **A booking confirmation now explains account credit that paid part of the
  stay (#2328).** A member who put $120.00 of account credit towards a $300.00
  booking was charged $180.00 on their card and then read "Total Paid: $300.00"
  in the confirmation, with nothing in the message to explain the difference —
  the email quoted the booking's price and never knew about the credit, which is
  recorded in the member credit ledger. Every confirmation now carries two
  reconciling lines beneath the total — `Account credit applied: -$120.00` and
  `Paid by card: $180.00` — so the three figures add up against the member's own
  card statement. `Total Paid` deliberately stays the booking's full price: the
  credit really did pay for part of the stay. Where money really did change
  hands, the second line names how the club was actually paid (`Paid by card`,
  `Paid by bank transfer`, or `Paid by cash or bank transfer` for a settlement an
  admin recorded by hand), read from the booking's own payment record. A booking
  that used no credit is unchanged, down to the byte — no blank line, no empty
  label. A stay fully covered by credit says `Nothing more to pay: $0.00`: the
  club took nothing by any method, and the payment record cannot say which method
  the member would have used, so none is named. A partly-paid settlement breaks
  down the slice that was settled, and a
  booking confirmed with money still owing states no payment at all. The built-in
  HTML email and the admin-editable body are built from one shared helper, so
  they cannot drift; clubs that write their own money lines in an override get a
  new `{{creditNote}}` token for the pair (existing overrides keep rendering and
  re-saving unchanged). Money stays in integer cents throughout.
- **One unreadable booking request no longer takes down the whole queue
  (#2342).** The **All** filter on the admin Booking Requests page returned a
  server error on any database holding a request whose saved guest list could
  not be read back — a missing surname was enough, and the demo seed shipped
  exactly such a row. Every request on the page disappeared behind that one bad
  row. Admin reads are now tolerant across all three saved blobs a request
  carries — its guest list, its member links, and its latest quote — so a row
  that fails validation renders in the list and in its own per-request payload
  under a **Saved details need attention** note instead of erroring the page.
  The note names only what actually failed, and shows the salvaged guest names
  as they were saved (line breaks collapsed, over-long values trimmed) rather
  than as confirmed details. Nothing about a well-formed request changed.
  Acting on such a request is refused rather than merely discouraged: Save
  quote, Send quote, Hold slots and Approve are turned off in the panel, and
  the server refuses quoting, pricing, holding and approving — including a
  school approval that supplies its own group numbers, which previously skipped
  the saved guest list altogether and could have invoiced a large group as a
  handful of people. Saving a quote no longer overwrites the stored member
  links with what the page happens to be displaying. Declining still works, and
  is the way out; the refusals now read as plain English rather than as a
  server error. The demo seed's school children now carry surnames, matching
  what the real school form writes.

- **A member merge that is overtaken mid-merge now stops cleanly instead of
  failing with an unexplained error (#2243).** Merging two member profiles runs
  as one long transaction, and it used to work out what to copy onto the
  surviving record the moment that transaction opened, then write it much later.
  A member photo can be uploaded at any time without waiting for a merge to
  finish, so an on-behalf photo upload landing in that gap left the merge writing
  a photo reference that had already been deleted — the database refused it and
  the whole merge rolled back as an unexplained error, with nothing in the
  operator's preview to hint at why. The merge now re-checks what it is about to
  copy just before it writes, covering every field it copies rather than photos
  alone (the duplicate's family group is the other one that could fail the same
  way), and locks both member records for that final step. If anything did change
  in the meantime, the merge stops with a clear message naming what changed,
  saves nothing, and asks the operator to re-run the preview — so what was
  previewed is always exactly what gets applied. Nothing changes for an ordinary
  merge. Two smaller corrections ride along: where a booking request was already
  turned into a booking for the duplicate, that link now follows the surviving
  member (it previously kept pointing at the deleted record); and the safety net
  that stops a new member-referencing column being forgotten by a merge now also
  covers columns that hold a member id without a database foreign key — two
  calendar columns had slipped past it — with a test that fails on the next one.
- **The finance dashboard was counting a paid price increase twice, and now
  counts it once (#2408).** When a booking's price goes up after it was made —
  someone adds a guest — the difference is tracked as an "additional payment".
  Once the member paid it, the finance dashboard's **Net collected cash** figure
  added that money in twice: a booking worth $121 whose $21 increase had been
  collected was reported as $142 of cash. The money was only ever received once;
  it was the report that was wrong, and it has read this way for as long as
  price increases have existed.

  **Net collected cash will therefore go DOWN.** It drops by the value of every
  collected price increase inside the range you are looking at, and by nothing
  else — no other figure on any screen changes. If you are comparing against a
  figure you wrote down last month, the new, smaller number is the correct one:
  it is the cash the club actually took. In this club's records only two
  bookings have ever had a collected increase, so the change to the published
  totals is small. Nothing about how payments are taken, recorded or refunded
  has changed.

  Two other things go with it. The card now says in so many words that it
  includes any collected price increase, so it is clear the figure is the whole
  of the cash rather than a part of it. And should a booking ever record an
  increase as collected without a matching payment record behind it — which no
  booking does today, but a data import or a future change could create — the
  dashboard now says so in an amber banner naming how much cash the figure may
  be short by and how many bookings are involved, instead of quietly publishing
  a number that is too low.
- **A web address that does not exist is now told "not found" honestly, so
  search engines and monitoring are no longer assured a dead address is fine
  (#2405).** Every reply carries a hidden status line that people never see but
  machines act on, and "the page you asked for does not exist" is a different
  status from "here is your page". When the two disagree, Google treats the dead
  address as real content worth listing, and a broken-link checker reports a
  club's site as healthy when it is not.

  The clear defect was in the club's data addresses — the `/api/...` ones that
  the booking screens, and anything a club plugs in later, talk to rather than
  people. Ask for one that does not exist and the reply was the club's entire
  "page not found" web page: about 23KB of layout, fonts and menus, sent to
  something that can only read short structured data and will choke on a web
  page. Every one of those addresses now answers with a short structured "not
  found" and the correct status — including the bare `/api` address itself,
  which the first cut of this work still left on the web-page path.

  Those replies are also worded identically, down to the last detail of the
  reply, to the one given when a switched-off feature hides an address, and that
  now holds for every kind of request rather than just the ordinary ones. Two
  ways of telling the two apart were found while reviewing this work and closed:
  a "headers only" request revealed the difference through a missing label, and
  an unusual request type revealed it through a different status. Either would
  have let a stranger, with no login and a single request, work out which
  optional features a club has switched on.

  For ordinary website addresses the decision that a page is missing is now
  taken alongside the page's own title lookup rather than only inside the page.
  That changes nothing a visitor can see today, and — worth being precise, since
  it was first described more ambitiously — it is a tidy-up rather than
  protection against future page-delivery speed-ups, which will need their own
  guard.

  Worth recording plainly, because the original report said otherwise: on a club
  whose website setup is finished — which is every club running normally — the
  ordinary mistyped and probed addresses were already answering correctly. The
  wrong answers came from a test site that had never had its site style
  completed, where an unfinished-setup holding screen answers every address. On
  a real club that holding screen only shows before the site goes live, but it
  does mean any address at all is answered as though it were fine until setup is
  finished. That behaviour is deliberately untouched by this change — altering
  it halfway would have let a stranger map an unlaunched club's page list by
  seeing which addresses answered differently. It is settled by the #2420 entry
  above, which turns the whole unfinished-setup site into a plain "not ready
  yet".
- **A member can now find and add another club member as a guest, and is told
  plainly what that commits the other person to (#2308).** The booking wizard's
  Guests step gains a **+ Add Member Guest** button beside the existing
  non-member one, and it opens a find box inline underneath the Guests heading —
  not a pop-up. One box takes either an exact email address or, where a club has
  deliberately switched name search on, a name that narrows as you type and picks
  itself when only one person is left. A household sharing one address produces a
  short pick-list; two members with the same name and age group look identical on
  purpose, and the box points at the email address rather than inventing a
  distinguishing detail the booker never had. A found member's full name and age
  group show straight away, and nothing else about them is ever shown — no
  email, no town, no photo, no membership type.

  Out of the box the membership list is not browsable: a member needs the other
  member's exact address, which they either have or have to go and ask for. The
  name-search setting ships **off** and is a per-club decision, and the admin
  card says in as many words what turning it on costs — your membership list
  becomes browsable to anyone who can start a booking. Under-18s stay out of that
  list unless a club separately opts them in. Every lookup in either mode is
  speed-limited against the member who typed it (not their internet address, so
  switching network gains nothing) and written to the audit log, which means
  anyone who can read that log will see the addresses and names members typed.
  With the feature switched off, neither find address exists at all — they answer
  as if the page were never built, rather than admitting the club has the feature
  and disabled it.

  While somebody is still deciding, the review step now states all four
  consequences plainly, before the money and never behind a "find out more" link:
  the bed is held and for how long, a refusal reprices the booking, **the person
  added can see the whole booking including the other guests' names before they
  decide**, and **their agreement covers the booking however the dates later
  change**, with taking themselves off subject to the usual limits once it is
  priced or paid. The wizard's own waiting labels name the person — "Waiting for
  Sam to approve", "Sam approved", "Sam will be told" — while the booking page
  keeps the wording it already had; both come out of one shared function so the
  two cannot drift apart. The admin settings card's "not in use yet" notice has
  been removed, because it no longer is.

- **Adding another member is harder to abuse as a way of tracking them
  (#2388).** A single refusal already said nothing — "This member can't be added
  to this booking right now", whatever the real reason — but somebody patient
  could try date after date and read the answer out of the pattern. Three things
  now sit behind that sentence. Anything involving a member from outside your own
  family group is speed-limited per person, so a run of attempts across many
  dates is slowed to something useless while an ordinary family booking is not
  slowed at all. "Involving" rather than "adding" is the point: the cheapest way
  to ask the question was to add the person once, then keep re-quoting new dates
  on that booking without naming them again — which cost nothing until this
  release. Every such preview now spends the same allowance an add does, once per
  request however many places in it could have charged.

  The "no such member" answer has stopped being the fast one, and three refusals
  that used to escape the neutral wording altogether now read exactly like every
  other one for a member outside your family: "linked member is inactive or not
  found", the age-exempt-account refusal, and — found in a second review of the
  same code — the membership-type refusal, which used to answer with the blocked
  member's NAME (or their email address, where their name was blank) and their
  membership category in as many words. A member adding their own child, and an
  admin acting on somebody's behalf, still get the detailed, actionable message.

  And repeated refusals against the same person are recorded where an admin can
  find them, flagged, naming both members — **once per pair per day**, raised when
  the line is first crossed rather than on every attempt after it. The earlier
  behaviour turned one afternoon of ordinary re-dating into a run of flagged
  entries about an innocent booker, which is how a club officer learns to scroll
  past the thing they were meant to notice.

  That last one is deliberately a record and **never a block**. Somebody trying
  five weekends to find one that suits a friend produces exactly the same pattern
  as somebody probing, and only a person who knows both of them can tell the
  difference — so the system writes it down and leaves the judgement to a club
  officer. The remaining limit is stated honestly rather than papered over: a
  patient member who stays inside the daily cap can still work out which nights
  another member is booked, over several days rather than minutes.

- **A member guest already on a booking is no longer described to the booker
  every time the dates change (#2308).** The rule that keeps one member's
  bookings private from another only ever applied to the person being added in
  that request. So a member added last week — a friend from another family, or
  someone who had never even answered the request yet — was still described in
  full on every later date change: their name, and the exact nights they were
  booked somewhere else, one short answer per set of dates, with none of the
  speed limits or records that were supposed to sit behind that question. The
  club now works out who is outside the booker's family from the booking itself
  rather than from what a single request happened to mention, so the neutral
  answer applies to everybody it was always meant to cover. Three further gaps
  found in the same review are closed with it: changing a booking through the
  edit panel now carries the same speed limit, record and equal timing as every
  other way of adding somebody; the "subscription unpaid" refusal is recorded and
  speed-limited like its siblings, though it is honestly still answered later
  than they are, because the limit is a minimum wait rather than a fixed one; and
  the speed limit itself no longer answered "too many requests" for a real member
  while answering the ordinary refusal for a made-up one, which had quietly
  turned the protection into the very thing it was there to prevent.

  Two more came out of a follow-up review. When you change only the dates on a
  booking that already has a member guest on it and the club refuses, the edit
  panel used to say "this member can't be added" — naming something you had not
  done, about somebody not mentioned anywhere on the screen. It now says the
  change can't be made, which is what actually happened. And the club-side work
  that decides who counts as "outside the family" no longer runs on every booking
  change at every club: it runs where the member-guest feature is switched on, or
  on a booking that has ever carried a member-guest request, so a club that never
  turned the feature on does not pay for it — and a club that turns it off does
  not lose the protection on the bookings it already has.

- **Smaller fixes in the same area (#2308).** A shared network — a family on the
  lodge wifi, or a club night — no longer runs out of lookups because everyone
  is behind one address; the per-person limit is the real control and the shared
  one is now sized for a crowd. The email finder gained a daily cap, which it
  had been missing while the optional name search had one. A rate-limited or
  malformed lookup now records what was being looked up, which is exactly the
  entry an admin would want. And the descriptions of what these limits buy have
  been corrected where they overstated it — "three weeks to map a season" was
  nearer three days, and "harvesting takes weeks" was nearer two days.
- **Cancelling one member of a family no longer wipes the whole family's bill
  (#2400).** When a family or billing group is charged for memberships, one Xero
  invoice covers everyone in the group. Until now, cancelling any one of those
  members credited that invoice's **entire** remaining balance — so cancelling
  one child cleared the bill for the parents and siblings who were staying, and
  nothing said so. The invoice simply went to zero, the memberships carried on,
  and the club quietly stopped being owed for them. It was invisible: no warning
  at approval, and no report that would show it.

  The rule now is the plain one. If the member leaving is the **last** one that
  invoice covers who is still with the club, nothing changes — the whole
  remaining balance is credited exactly as before, which is what happens for the
  ordinary single-member cancellation. If **other members it covers are
  staying**, no credit note is raised at all: the invoice is left exactly as it
  is, because the club is genuinely still owed it by the people who remain. The
  review queue says so before you approve, in a blue notice that names the
  members who are staying and links the invoice straight into Xero, so a credit
  note can be raised by hand if one really is due. What was silently wrong is
  now visibly deliberate.

  Cancelling a whole family still works, and still credits the invoice in full —
  approve them one at a time and the last approval does it, because by then
  nobody else the invoice covers is with the club any more. The member who holds
  the family's Xero contact normally has to go last: while the others are still
  members, their share of that invoice is real money owing, so the check
  introduced with #2392 rightly refuses to archive that contact over it, and the
  notice beside them says plainly that the approval will be refused rather than
  simply go through. Cancel the rest of the family first and that refusal clears
  by itself. Where a whole family shares a single Xero contact — which happens
  when children inherit a parent's email address — approving them in any order
  gets nowhere, because every one of them is refused over the same invoice; the
  notice says that too, instead of sending you round the loop, and points at
  settling, crediting or voiding the invoice in Xero. So does the refusal
  itself, so an admin approving from a stale page gets the real answer and not
  just "pay, credit or void it". The same goes for members who were deactivated
  rather than cancelled: there is no cancellation to approve for them, and they
  keep the invoice open by design.

  Two quieter fixes travel with it. Approving a family in a burst could raise
  **two** full-balance credit notes for one invoice, when two of the approvals
  reached the "nobody else is covered" moment together in overlapping background
  runs — Xero accepted both, allocated one, and left the other sitting on the
  family's contact as unallocated credit anyone could spend. The right to credit
  an invoice is now claimed once before anything is sent to Xero, so the second
  cancellation raises nothing and records why. And a family whose last member out
  had already **paid** their own subscription used to leave the invoice with its
  full balance and say nothing at all — the cancellation credited nothing, and
  the archive check would later wave the invoice through as "about to be
  credited" when its credit note had already been and gone, archiving the Xero
  contact over live money. The check now reads what the credit note actually did,
  never what it would do if it ran again, and an admin alert names any invoice a
  cancellation walks away from with nobody left to pay it.

  That check moved with this change, and had to. It deliberately ignores the
  member's own subscription invoice, on the grounds that the cancellation is
  about to credit it. That is now true only when the credit will clear the whole
  balance, so the exemption applies only then: an invoice this cancellation is
  not going to credit is treated like any other money owing, and cannot be
  archived out of sight behind a closed contact. Both halves ask the same
  question of the same rule, so the invoice the approval excuses is always
  exactly the invoice it is about to clear.

- **A young member can now be recorded as a parent (#2282).** A 16 or 17 year
  old can genuinely be a parent, and until now the club simply could not write
  that down: adding a dependant refused with "Dependants can only be linked
  under active adult members", and the search never offered a non-adult, so the
  only options were to leave the child looking parentless or to attach them to a
  grandparent. Both record the wrong thing. **The family relationship can now be
  recorded at any age.**
  **Nothing about responsibility has moved.** Being someone's recorded parent
  never granted the powers people assume it does — booking on another member's
  behalf, editing or confirming their details, answering a consent request for
  them, and billing are all decided by family-group membership plus being an
  active adult with a login, and none of them looks at the parent link at all.
  Those rules are untouched. In particular the club's **contact of record** for
  a child's mail is still an adult: a dependant added under a young parent has
  their notifications routed on up to the nearest adult in the family, usually
  the young parent's own parent, and the member's page now says on screen which
  adult that is *before* you add the dependant. The two "link" dialogs say it
  too, next to the notification-recipient list — that list names *parents*, and
  the person the mail actually reaches can be someone further up, which the
  screen used not to mention. If no adult in the family has a real email
  address, adding the dependant is refused with that reason rather than quietly
  leaving the child unreachable.
  **Organisation and school accounts are not people**, so they cannot be
  recorded as anyone's parent — they were never offered before, and are not
  offered now.
  **The dead ends are gone too.** "Add Dependent" used to disappear entirely on
  a member who could not have one, teaching an admin nothing; on an inactive or
  archived member it stayed and then failed on save. It is now always shown, and
  disabled with the reason — "This member is inactive — reactivate them to add
  dependents" — on both the *create new* and *link existing* paths, with the
  reason read out to screen readers alongside the control rather than merely
  sitting beside it. Where a dependant genuinely cannot be added because no
  adult in the family can receive club email, the dialog now says so *and*
  points at the way that does work, instead of letting the save fail. And the
  copy that claimed only adults can manage dependants is gone, because that is
  no longer the rule.
  Two smaller corrections ride along: the age-up job's "your child is becoming
  an adult" notice now goes to the family's actual contact of record instead of
  whoever the parent link names, and creating a member under a parent without
  asking for inherited email no longer records them as inheriting from nobody.
- **Clubs that had saved their own email wording stop emailing our editing notes
  (#2269).** Older releases shipped little square-bracketed notes inside the
  built-in email wording — things like `Door code: {{doorCode}} [only when a door
  code is set]`. They were written for whoever was reading the template, but
  emails fill in `{{tokens}}` and copy everything else through exactly as typed,
  so those notes were being sent to members word for word. Earlier fixes cleaned
  the built-in wording, which quietly fixed every club that had not customised
  the message. A club that had **saved its own copy** of a message kept its copy,
  and so kept the notes, for ever. This release repairs those saved copies on
  upgrade. It matches the **exact** notes this project shipped — not anything
  that merely looks like one — and leaves the rest of your wording byte for byte
  as it was. Your own square-bracketed text is never touched, even when it reads
  like ours (`[when you are 30 minutes away]` is your wording, and it stays);
  such text keeps being flagged in the admin screen for a person to decide
  about, rather than deleted by a script. The trade we chose deliberately: if
  one of our notes was retyped or re-spaced by an admin at some point, the
  repair leaves it alone rather than risk deleting something you meant, and the
  admin screen keeps flagging it. Every message the repair changes is recorded
  in the audit log with the whole before and after, so a club can see exactly
  what we changed and, with an administrator's help, restore any of it.
  **Every message the repair touched is named on screen afterwards.** Some of
  those notes were the only thing marking a line as conditional — `Payment has
  been processed successfully.` was our wording, with `[only when the booking is
  already paid]` beside it — so once the note goes, that line sends every time,
  including on a booking that still owes money. **Admin → Email messages** lists
  each repaired message, the notes removed and the lines they were attached to,
  so an admin can read them and fix anything that no longer makes sense. Saving
  the message clears the notice. **And Restore Default now keeps a full copy.**
  It still deletes your wording and still cannot be undone from that screen, but
  the subject and body it deletes are written to the audit log in full — not an
  extract — so an administrator can read them back.
  **And the editor now tells you when your saved wording has fallen behind.**
  **Admin → Email messages** names any message whose saved copy no longer shows
  something that message is required to tell the recipient — most often a
  booking confirmation saved before the promo explanation moved into its own
  token, which now shows a subtotal and a total with nothing in between to
  explain the difference. Open that message and **Show differences** lays your
  saved copy beside the current built-in wording line by line, so you can patch
  your own words or restore the default knowing exactly what you would be giving
  up. Wording that simply *reads* differently is reported as a plain difference
  and never as a problem — that is what saving your own copy is for.
- **The public site no longer advertises guest bookings (#2421).** The
  signed-out help corpus previously answered "Can I stay without being a
  member?" with "Yes", and the sign-in page carried a *Request a booking
  without an account* link. Whether a club hosts non-members is the club's own
  policy — often only as a guest accompanied by a member, if at all — and
  advertising open guest bookings can read as commercial accommodation. Every
  public string now defers to the club's own FAQ, rules, or policy pages, and
  the sign-in-page link is gone (the school-group link is unchanged). The
  request form itself still works exactly as before, by direct URL: it is now
  excluded from search engines via a route-level `noindex` (`robots.txt`
  deliberately does *not* disallow it, so crawlers can fetch the page and see
  the noindex), no page a visitor can browse to links to it, and admins copy
  its link from a new **Guest request form link (unlisted)** field on the
  **Public Requests** tab of Booking Requests — visible to view-only admins,
  since sharing a link is not a booking write. The one other way in is
  unchanged: the *Book these dates again* button on a tokenised payment link
  the club itself emails to a past requester.
- **Reports can jump to the next calendar month (#2367).** The Reports page's
  Quick Range menu now includes **Next Month**, including December-to-January
  and leap-year February boundaries. Changing the quick range keeps the current
  Lodge and Deleted filters, and the shared Quick Range select now has an
  accessible programmatic label.
- **Admin datasets now share one predictable Reset action (#2358).** Across 22
  member, booking, finance, support, Xero, induction, promo, and locker lists,
  **Reset** stays visible and is disabled only when search, filters, explicit
  sort, and page are already at that dataset's defaults. It resets the whole
  dataset rather than only the last control, uses replace-style URL updates so
  filter changes do not fill browser history, and preserves work context such
  as lodge, season, tab, cohort, focused record, sibling Xero panel state, and
  unknown future URL keys. Payments returns to the rolling NZ three-month
  Updated range through today (not all history), while Reports returns to its
  month-boundary default through current month-end and keeps the selected
  lodge. Finance Dashboard keeps the current view and lodge while restoring
  Last Month, Previous Period, Next Month, and empty expense filters.
- **Bed moves now stay on the guest's original lodge nights (#2366).** Dragging
  an existing allocation chip across date columns now chooses only the
  destination bed: the preview and keyboard announcement show the original NZ
  night that will be kept. The first visible chip still moves all of that
  guest's visible allocated nights together, while later chips move one night.
  A drop explicitly says **No change** and creates no audit entry only when
  every represented row already uses that bed; mixed-bed proxy rows still
  converge on it. Bucket removal names and removes only the dragged night,
  unbooked single-night targets are refused locally, and drag-end feedback says
  a valid request is saving instead of announcing success before the server.
  Cancelled drags do nothing.
  Grouped moves are all-or-nothing, and the bed changes, shared-double partner
  promotions and audit records now commit in one global-then-destination-lodge
  locked transaction instead of the browser creating a target night and then
  trying to delete the original. The shared global lock also prevents a
  concurrent cancellation from pruning and then having the move resurrect an
  allocation.

- **Editing a booking no longer takes away a promo discount the club already
  gave (#2390).** A promotion's usage limits are checked again every time a
  booking is repriced — a date change, a guest added or removed, an edit from
  the Edit panel. If other members had used the code up in the meantime, the
  edit used to fail that check, and failing it stripped the promotion from the
  booking *entirely*: everyone on it lost the discount, including the people who
  already had it, and the member was billed the difference for changing a date.

  Now the edit always goes through, everyone already benefiting keeps their
  discount, and only people the edit newly adds are priced at the normal rate.
  Where there is not enough room for everybody, the people who already had the
  discount keep it and the remaining room goes to the most expensive stays
  first, so the code is worth as much as it can be to the booking. The member is
  told before they save, in one sentence naming who keeps it, who this edit
  brought under it, who is not covered, and confirming that the total on screen
  already reflects it — and that same sentence goes into their booking-modified
  email and onto the booking's own history, so nobody has to work it out
  afterwards. On a free-nights code, a member who already had free nights on the
  booking keeps them even if an admin has since lowered the lifetime limit.

  This also settles what happens when an admin **lowers** a limit on a code
  members are already using: the bookings that already have the discount keep
  it, so "Benefits given" can sit above the new limit until those stays pass.
  That is the club honouring what it already promised, not a fault — and no new
  member is given the code while it is over. If a code is exhausted and nobody
  on the booking was benefiting from it, the edit removes it from the booking as
  before; nobody loses anything, because nobody had anything.
- **Recording a cash payment now asks about any extra still owing (#2397).**
  When a booking is priced up after it was made — someone adds a guest, say —
  the increase is tracked separately as an "additional payment" the member is
  normally asked to pay by card. Until now, recording the booking as paid in
  cash or by an off-Xero bank transfer said nothing about that extra and left it
  recorded as still owing: the bookings list kept showing a "$X due" chip
  against a fully settled booking, the reports counted the money as uncollected,
  and the reminder emails would have gone on asking the member for money the
  club already had. **Record manual payment** now shows the split — the booking
  amount before the change, the extra, and what the booking owes in total — and
  asks whether the money you received covers the addition as well. Say **yes**
  and the full amount is recorded and the addition marked settled, so nothing
  chases the member again and the booking's history says the payment covered it.
  Say **no** and only the amount owed *before* the change is recorded: the
  booking is still marked paid, but the books say the club received that smaller
  amount and is still owed the addition, so the figures add up and the member is
  rightly still asked for the rest. Neither answer is a default, you cannot
  record the payment until you have chosen, and the dialog does not name a total
  until you have — because your answer changes it. Bookings with no such extra —
  nearly all of them — see the dialog completely unchanged. Reversing a manual
  payment gives back exactly what it recorded, putting a covered addition back
  to owing.

  If you answer **no**, the member is left a way to pay. Recording a cash
  payment normally closes any card payment the member still had open, so they
  cannot pay twice for money the club already holds; the card payment for the
  addition itself is now the one exception, because that money is still being
  asked for. The member can settle it from their own booking page exactly as
  before, and the confirmation on screen tells you whether they can — or whether
  someone will need to contact them instead. Their confirmation email says the
  same thing: rather than claiming the booking was paid in full, it shows the
  booking total, what has been paid and what is still owing, and how to pay the
  rest. Separately, a booking whose card payment has already taken money can no
  longer be offered the cash-payment button at all: it now says why, instead of
  refusing every attempt with a message about the booking having changed. Where
  more than one reason applies, the most specific one is shown — a payment that
  has already had money refunded says so, and says to resolve the refund first —
  and it is the same sentence before you click as after.

- **The Whakapapa conditions widget survives the source page changing, and now
  shows the trails.** The public widget is scraped from an external report page
  whose style names carry a build hash that changes every time that site
  redeploys — and each time it did, a section quietly went blank (road status was
  broken this way when this work started). The scraper now matches on the stable
  parts of the page rather than those rotating hashes, so a routine upstream
  rebuild no longer breaks it. A new **Trails** section joins road status, lifts,
  facilities, food & drink and conditions: trails are grouped by sub-area (small
  neighbouring areas share a line to save space) and each shows its run
  difficulty as the standard ski symbol — green circle, blue square, black
  diamond, red diamond — with a matching key, plus whether it is groomed and its
  size. The status badges gained **On Hold** (yellow) alongside Open, Closed and
  Coming Soon, and an **Unknown** state renders grey. Operators get a new
  **Source & selectors** panel on *Admin → Mountain Conditions*: set the report
  URL (locked to whakapapa.com / snow.nz so it can never be pointed at an
  internal address), and, only if a deeper page change defeats the defaults,
  override the per-section element selectors — with a **Preview** that fetches
  and parses without saving, and a save that refuses a malformed selector up
  front (naming the field) instead of storing one that would throw on every
  later scrape. The built-in selector set is seeded into the database, and the
  whole configuration can be **exported and imported as a JSON file** so one
  site's known-good settings can be handed to another rather than re-entered by
  hand.

- **A cancellation is no longer approved while the member's Xero contact still
  has money owing (#2392).** Approving a cancellation archives that member's
  contact in Xero, and an archived contact drops out of Xero's pickers and can
  no longer be invoiced, credited or paid. Nothing used to check whether the
  club was still owed anything by it — the approval only looked at future
  bookings — so the club could quietly archive an account it was in the middle
  of chasing. That became likelier once school and organisation accounts became
  cancellable, because an organisation is usually the billing contact for its
  booking invoices rather than only its own membership. The approval is now
  refused instead, and the refusal tells the reviewer exactly what is in the way:
  each invoice by number and the amount still owing, and that each one needs to
  be paid, credited with an allocated credit note, or voided in Xero before the
  cancellation can go through. Voiding is the right answer for an invoice nobody
  intends to collect, so a cancellation is never held hostage by a debt the club
  has already written off. "Owing" means what an accountant means by it — an
  approved or submitted invoice with a balance left. Drafts are ignored, since
  they have never been issued; voided, deleted and paid invoices are ignored,
  since nothing is due; and a credit note that only partly covers an invoice
  still counts, for whatever is left, which is the figure shown. Bills the club
  owes the contact count too, for the same reason. The member's own unpaid
  season subscription is deliberately not counted, because approving the
  cancellation is what credits it — counting it would make the most ordinary
  cancellation of all impossible to approve. (An invoice for *next* season, at a
  club that bills early, is not credited by the cancellation and so does count;
  void it in Xero, which is right anyway for a member who is leaving.) If Xero
  cannot be asked at all — not connected, rate limited, unreachable, or refusing
  the request because the member's Xero contact has been merged or deleted there
  — the approval is refused rather than let through, because "we could not find
  out" is not the same answer as "nothing is owing". The notice says which of
  those it is and what to do about that particular one, including whether
  waiting will help at all, and **every** version of it also offers the way out:
  switching **Archive Xero contacts after cancellation approval** off means no
  contact is archived, so the check is not needed. None of this applies to a
  club that has that setting off already, or to a member with no Xero contact:
  nothing is archived in either case, so nothing is checked and a Xero outage
  cannot hold up a cancellation. The review queue shows the outstanding invoices
  next to each participant that is ready for review — each one linked straight
  into Xero, so a bill or an invoice Xero never numbered can still be opened in
  one click — so a reviewer finds out before they press Approve rather than
  after. Finally, because the Xero archive itself happens later on the sync
  queue rather than at the moment of approval, it asks the same question again
  just before it runs and holds off if the answer has changed since.

- **A promo code that turned out to be worth nothing no longer uses up
  someone's one permitted go at it (#2299).** Until now the system counted a
  promo code as "used" the moment it was applied to a booking with eligible
  guests, whether or not it actually took anything off the price. That is
  easier to hit than it sounds and needs no bug anywhere: a percentage-off or
  money-off code does nothing on nights that are already free (young children,
  a zero-dollar stay — 20% of nothing is nothing), and a "fixed price per
  night" code set to price everyone at, say, $30 does nothing for a member
  already paying exactly $30. The member got no money off and was then told,
  for ever, "You have already used this promo code". The empty use also counted
  toward the code's total-redemptions limit and took up one of its
  unique-member places, so a code could look exhausted when nobody had
  benefited from it at all.

  A use now means the member actually got something — money off, a change to
  what they pay, or a subsidised night. All three limits (uses per member,
  total redemptions, unique members) count only those, matching how the
  lifetime free-nights allowance has always worked. The application is still
  recorded and still appears in the code's redemptions report, so an operator
  can see that a code is being applied fruitlessly — usually the sign that it
  is set up wrong for the stays people are booking. The promo code card now
  says exactly that: **Benefits given** (counted once per member, per booking —
  which is what the total-uses limit counts), and underneath it, always, how
  many bookings the code has been applied to and how many of those gave nobody
  anything. The redemptions report has been reorganised to match: four tiles
  count applications and follow whatever filter you set, two count benefits and
  carry the cap progress, each says which it is, and any application that gave
  no benefit is tagged in the table so you can find it. A fixed nightly price
  set *above* someone's normal rate raises what they pay — a real use with no
  discount — so those rows now show the price increase alongside the $0
  discount rather than looking like an empty application.

  If a booking is later edited so its promo benefit disappears, the allowance it
  was holding is handed back at the same moment, so nobody is left paying full
  price while still counted as having used the code. Two edge cases were fixed
  along the way: a booking holding a code's last remaining use no longer loses
  its discount — and get billed the discount back — merely for shifting its
  dates or adding a guest; and all four ways of editing a booking now take the
  same lock on the promo code before checking its limits, so two people editing
  different bookings at the same moment cannot both take the last use.

  One deliberate line: if a fixed-nightly code re-prices someone's nights and
  the increases and decreases cancel out to exactly nothing, that counts as no
  use. Their total is identical with and without the code, so the code can go on
  being applied to such a stay — which costs nothing, because it gives nothing.

  Existing sites are repaired on upgrade: benefit-free records stop counting
  immediately, the dead rows are cleared out, and each code's redemption total
  is recalculated from what is left. Expect the benefits figure on some codes to
  drop the first time you look — that is the correction, not a loss. Nothing in
  the redemptions report or its CSV is removed; only what counts as a use
  changes.

- **Money still owed after a booking change is now visible everywhere, and the
  member is actually asked for it (#2350).** When a change pushed a confirmed
  booking's price up — an admin adding a non-member guest, say — the difference
  became an "additional payment" the member had to make from their own booking
  page. Nothing chased them for it, no admin screen showed it, and the revenue
  report counted it as money in the bank. It could sit there indefinitely, and
  did.

  The bookings list now says when the money is short: such a row reads **Partly
  paid** with an amber **"$210.00 due"** beside it. The booking's own status chip
  still reads Paid,
  which is right — the stay is confirmed; it is the money that is short. Opening
  the booking gives any admin an **Additional payment outstanding** panel with
  the amount, when the change was made and how long ago, whether the last
  attempt to charge the card failed, and when the member was last emailed. It is
  read-only on purpose: nothing here takes, waives or zeroes the money, because
  collecting it belongs to the member's own card or to an ordinary booking
  change. The booking's timeline gains the entry that was missing too — it
  recorded an extra payment succeeding and failing, but never its being asked
  for in the first place.

  The member is now chased while it still matters: a few days after the change,
  and once more shortly before check-in, with the pre-arrival message naming the
  amount as well. An admin can send the same message on demand with **Resend
  payment request email**, which takes the place of whichever automatic reminder
  was coming rather than adding to it. Automatic and manual sends share one
  clock, so a member emailed within the last hour — by an officer, or by the
  reminder — is not chased twice over, and every re-send is audited. A booking
  with the **No emails** switch on is refused with an explanation rather than
  silently swallowed, and a message the mail system withholds (a bounced address,
  a member with no real address on file) is reported as not sent rather than
  counted as sent. Only confirmed, paid and completed bookings are chased at all
  — cancelling a booking ends the club's claim on the difference, and no screen
  calls it outstanding afterwards. **A cancelled booking no longer offers the
  member a way to pay it, either:** the pay-the-extra card and the card form
  behind it were still being shown on a cancelled booking, and because
  cancelling does not always close the card charge at the payment provider, a
  member could complete a payment for a stay that no longer existed. (The system
  refunded it automatically and alerted the club, but the member had still been
  charged.) Both now check the booking's state before offering anything. Changes
  made before this shipped are shown but never emailed about automatically, so
  going live does not mail the backlog — and that cut-off is now taken from the
  moment the reminders first ran on the club's own system rather than a date
  written into the code in advance, so it stays right however long the release
  takes.
  Nothing is ever auto-cancelled or expired over an unpaid addition,
  and the chasing stops once the stay is over: from then on it is a
  conversation, which is what the dashboard card is for.

  That dashboard card and its sidebar badge stopped being finished-stays-only.
  They now count upcoming stays too — the half that can still be chased — shown
  as "3 upcoming, 1 finished" behind one link to the owed filter. And the money
  is honest on the finance surfaces: the reports page's revenue figure keeps its
  meaning but is labelled **Booked Revenue**, with **Outstanding Additions**
  beside it (in the CSV as well, along with the subtraction), and the finance
  dashboard finally renders the additional-payment split it had been quietly
  computing all along.

- **Xero setup no longer gets stuck on "Confirming the organisation name…"
  (#2394).** After connecting Xero, the setup wizard fetches your organisation's
  name so you can check you picked the right one. That fetch happened exactly
  once, and if it failed — because Xero was momentarily busy, briefly
  unreachable, or the connection needed re-authorising — the page simply sat on
  "Confirming the organisation name…" with no explanation, no way to retry, and
  no way forward. The only escape was guessing that a reload might help.

  The step now tells you what actually happened, in the terms that decide what
  you should do about it, and offers a **Try again** button wherever pressing it
  could genuinely help — including when Xero's daily limit has been reached,
  since that limit can clear while you are still on the page. If Xero needs
  re-authorising, it says so and points at Disconnect and Connect, and offers no
  button, because retrying would never have worked. If the daily limit was hit
  it says when that clears — midnight UTC, about midday in New Zealand — so you
  can judge whether to wait or come back tomorrow. If your sign-in has simply
  expired it tells you to sign in again rather than blaming your permissions,
  and if your admin role really isn't allowed to read the organisation it says
  that instead of pretending a retry might fix it. Each attempt is stamped
  ("Checked 3 times, most recently at 2:32 pm") so a repeat failure is visible
  rather than a silent flicker.

  Nothing retries on its own, deliberately. Each Xero connection has a limited
  number of calls per day, and hammering a limit that has already been hit only
  makes it last longer — so apart from one fresh check when you come back from
  authorising Xero (where the organisation may have just changed), a live check
  happens only when you press the button. That check can also no longer put the
  rest of the Xero integration on hold: it used to be able to trip the app-wide
  "Xero looks unwell, pause everything" guard that stops invoicing and syncing
  for a couple of minutes, and a button inviting you to press it during an
  outage should never be able to do that.

  Two related gaps closed at the same time. If Xero refused the authorisation
  itself, the wizard used to show only "Not Connected" with no hint that
  anything had gone wrong; it now says the connection attempt failed and what to
  do about it. (It deliberately does not quote Xero's own wording back at you —
  that text arrives through the browser and cannot be trusted to be Xero's.) And
  a connected organisation whose name we could not re-check no longer shows a
  green "all set" tick: it now says plainly that the name is the last one we
  saw, not a confirmation — which is what you would see if the club revoked the
  app inside Xero.
- **A refused save no longer blames the email address when the email address is
  not the problem, and switching a family's login holder now explains an email
  clash (#2385).** Only one member per email address can sign in — that is why a
  family's children can share a parent's address as long as they do not log in
  themselves. Three changes, all about being told the truth when a save is
  refused:

  - On a member's **Account & Access** tab, ticking **Can Login** when that
    member's address is already someone else's login is now spotted before the
    save is attempted rather than by letting the database reject it. Admins see
    the same message as before — "A member with this email already exists" — so
    nothing looks different; the save simply stops earlier.
  - What *has* changed is what a member save says when the database refuses it
    because two records would end up sharing something that has to be unique to
    one of them. Whatever the duplicated detail actually was, that used to be
    reported as an email clash. Only a genuine email clash says so now;
    anything else is reported as a general failure and recorded in the logs for
    an administrator to look at. Nobody is sent off to fix an address that was
    never wrong.
  - On a family group's **Shared email & login** panel, handing the login to a
    different adult when someone **outside that family** already signs in with
    the address used to fail with an unexplained error. It now says "A member
    with this email already exists", and the same message is given to whichever
    of two admins loses a race to claim the address at the same moment.

  Nothing about who is allowed to sign in has changed — the database rule that
  permits only one login per address was always doing its job, and still is.

- **Clubs can safely record a trusted induction history when moving an
  established membership onto the digital register (#2361).** A new
  dry-run-first operator command classifies every active real-member
  (`USER`/`ADMIN`) record across the configured Infant, Child, Youth, and Adult
  tiers, includes non-login dependants, excludes operational and non-member
  contacts, reports an in-scope `N/A` separately, and preserves anyone who
  already has a completed induction of any kind. Apply needs a login-enabled
  Full Admin actor, one New Zealand baseline date, stable source provenance,
  and exact club, database, and reviewed SHA-256 plan-digest confirmations.
  Apply rebuilds the complete safe plan under its table lock and rejects stale
  digests before blocker, no-op, or write handling. It refuses to run
  over an open induction, locks direct induction-table writes during apply, and
  commits all completed New Member baseline rows with one audit event or none
  at all. The runbook requires a short member-population, induction, and
  configuration, group-join member-creation, and actor-access freeze from the
  final dry run through post-apply verification because the table lock does not
  freeze those inputs.
  The records are explicit Admin Overrides with no invented signers, sign-offs,
  emails, or hut-leader eligibility; a fresh post-apply dry-run digest permits
  an identical no-op rerun while the stale pre-apply digest fails closed. The new
  operator runbook documents rehearsal, review, verification, and recovery.
- **The browser test suite stopped crying wolf (#2302).** Over three days five
  different browser tests went red on code that was perfectly fine, each costing
  someone an investigation and one of them turning the main branch red for the
  best part of an hour. None of it was a real defect, and none of it was
  "slowness" either. Two causes were behind all five.

  The first: when a browser test fails, it is automatically run again — but it
  was run again against the *leftovers* of the attempt that just failed. A test
  that books a bed on its way to the thing it actually checks left that booking
  behind, so the second and third attempts failed on the booking clash rather
  than on the original problem, and the error finally reported was the clean-up
  mess rather than the cause. Tests that permanently change something now put it
  back before each attempt, and each attempt books different nights, so a repeat
  run starts from where the first one did. Where a test genuinely has to re-use
  or move the booking an earlier test made, and so cannot simply pick different
  nights, it clears that booking before every attempt instead. Groups of tests
  that used to be chained together end to end have also been unchained down to
  the pairs that genuinely depend on each other, so one test's bad luck can no
  longer drag its neighbours down with it. Relatedly, the tests reach a booking's
  dates by paging forward through the booking calendar a month at a time: that
  walk now has room for the furthest dates a repeat run can ask for, and says so
  plainly if it ever runs out, instead of quietly stopping on the wrong month and
  failing later on a day it was never showing.

  The second: the pages that stream in progressively briefly contain each piece
  of text twice — once in the version being delivered and once in the version
  being shown — and a test that looked for text by wording alone could catch the
  invisible copy and give up. Those checks now look for the copy that is actually
  on screen.

  Also fixed: the stand-in Xero server used by the tests calls the app back
  through its own network loopback, which on a busy build machine occasionally
  refuses the connection; a single refused connection used to leave the Xero
  setup wizard stuck on "Confirming the organisation name…" for the rest of the
  test. That call now retries. The testing guide gains a "Flake invariants"
  section so a future test cannot quietly reintroduce any of this. No part of
  this touches the running club site.

- **The "page not found" page is now always assembled fresh, closing a small
  security-policy inconsistency (#2356).** This is a correctness and
  future-proofing fix rather than something most visitors would have noticed. A
  copy of the 404 page was being built once, in advance, when the software was
  packaged — before it had any connection to your club's database — and frozen.
  That frozen copy still carried the template's demo club name and ignored the
  404 page you can write yourself under **Website content**, and its scripts were
  blocked by the site's own security policy. In ordinary browsing you would not
  have met it: a mistyped or dead web address is handled elsewhere in the site
  and already produced a correct, live page with your own club name. The frozen
  copy was reached only by two internal request shapes that browsers and normal
  scanners do not use. It is now assembled on request like every other page, so
  the inconsistency is gone rather than waiting to surface, and a check runs on
  every build so no other page can be frozen in the same way unnoticed.

- **Server-side errors are now actually reported to error monitoring (#2356).**
  The hook that hands a server-side page error to Sentry had been written in the
  wrong file, so the framework never found it and never called it. Nothing failed
  visibly — errors simply went unreported through that channel. It is now wired
  up correctly and covered by a test, so if it is ever moved again the build
  fails instead of the reports quietly stopping. Clubs that have not configured
  Sentry are unaffected.

- **Adding another club member as a guest (#2306, #2307).** Until now a member
  could only put people from their own family group on a booking. There is now a
  new **Add another member as a guest** switch on **Admin → Modules**, off by
  default, and with it on a member can put *any* active club member on their
  booking — with that member's agreement. By default the other member is emailed
  and asked first, and a bed is held for them until they answer or the request
  lapses. A club can instead choose to tell them rather than ask, and can set how
  long a request waits (7 days by default, anywhere from 1 to 60) on the new
  **Member guests** card under **Admin → Bookings setup**. An unanswered request
  lapses on its own the night before check-in at the latest, the held bed is
  released, and the person who made the booking is told what happened — including
  the money, which comes back as account credit rather than an unasked-for card
  refund.
  A member who has been asked but has not answered yet holds a bed and nothing
  else: they are deliberately kept off the kiosk arrivals list, the chore roster,
  bed allocation, the hut-leader pickers, the lodge TV board and the arrival
  emails until they accept, so nobody is counted, rostered or given a bed for a
  stay they have not agreed to. And two settings that would make your membership
  list browsable to any member ship **off** and never travel in a club config
  transfer, so importing another club's settings can never widen your members'
  privacy without your own admin choosing it.
  **The screens are here too, so the module is usable end to end.** A member who
  has been asked sees the question on the booking itself: a **consent card** at
  the top of the booking page states who added them, the lodge, the dates, their
  own nights, the deadline, and everyone on the booking — names only, no money —
  with **Yes, add me** and **No thanks** side by side. When saying no cannot
  actually work (they are the last guest, or the booking was priced by hand),
  the card says so *before* the click and names who really can act; when only
  the server can know (an already-paid booking needs a refund-or-credit
  decision), the card keeps both buttons and repeats the server's answer word
  for word. For a member with no login of their own — a child, or an adult on a
  household login — the emailed request goes to the adults in their family
  group, whose link opens a dedicated **consent page** showing just the
  question and the facts: a delegate answers *for* the member, with their name
  recorded against the answer, and deliberately never sees the booking page or
  any of its money. Everyone who can see the booking now also sees each member
  guest's consent state as a badge on the guest list — *Waiting for consent*,
  *Consented*, *Consented by …*, *Told, not asked*, *Added by …*, or the two
  stuck states below — while family and non-member guests are unchanged. And
  admins get the leftovers that genuinely need a human: two filter chips on
  **Admin → Bookings** — **Waiting for consent** and **Consent needs
  attention** — where the attention view lists each stuck request with why it
  is stuck and what actually fixes it (cancel the booking, add another guest,
  re-quote the request), never a dead-end "ask the club".
  The published banner-coverage figures were re-measured with the new settings
  card: **310** gated admin controls, **261** of them covered by a banner (234
  in their own file, 27 by a verified vouching parent — 5 of those through the
  wizard frame), and **49** across 26 files deliberately keeping their own
  reason.
  **Review hardening in the same change.** A "no thanks" that the system cannot
  carry out — an already-paid booking whose refund-or-credit choice only the club
  can make, or a booking the member is the only guest on — now leaves the member
  exactly where they were, on the booking and on the club's list, instead of
  half-removing them. The person who made the booking is told what actually
  happened: a decline is reported as a decline rather than as "did not answer in
  time", a lapse is dated by the day the request really ran out, and a
  paid-booking refusal says so plainly instead of "this booking is in a state the
  system cannot change on its own". Nobody in a family can answer for a member who
  has a login of their own — that member decides for themselves — and when an
  adult does answer for a member who has no login, that member and the rest of the
  household are now emailed to say who answered and what they said. The consent
  request and the consent card no longer promise that the held bed is always
  released when a request lapses, because occasionally it cannot be. A member who
  has been asked but has not answered is also no longer shown the lodge door code,
  and an officer can no longer hand-write a bed for one.
  We also fixed an unrelated bug we found next door while doing this: the
  **check-in reminder** email joined every guest's first names together and then
  every guest's last names, so the guest list read `Ada, Bob, Cleo Lovelace,
  Smith, Jones`. It now lists each guest's own full name, one per line.
- **A member's membership can now be cancelled without first destroying their
  admin access, and school and organisation accounts can be cancelled at all
  (#2383).** The old rule claimed to allow "only member accounts", but what it
  actually tested was whether the account held the full admin bundle — so a
  Membership Officer, Booking Officer, Treasurer, Content Manager or holder of
  a club-defined custom role was cancellable all along, and only a Full Admin
  was refused. That refusal had no way out worth using: to cancel a Full
  Admin's membership you first had to strip their access, which throws away
  every privileged role they held and cannot be given back from the member page
  afterwards, because a cancelled member cannot be reactivated there. Worse,
  nobody can strip their own access, so a departing sole admin could not cancel
  their own membership by any route at all. The same rule also refused school
  and organisation accounts, which hold real fee-paying memberships and had no
  cancellation path whatsoever. Cancellation now asks the only question that
  matters — is there an account holder here with a membership? — so every
  member is cancellable whatever admin access they hold, as is every
  organisation account. Two kinds of record are still refused, because they are
  not people and hold no membership: the lodge kiosk device login, and the
  contact records the booking-request flows create (a public request's guest
  contact, and a school request's owner contact and teacher records). Those
  simply show no cancellation action, with nothing to explain, because nothing
  is being withheld. "The lodge kiosk" here means the shared device account
  itself — the one whose account type reads *Lodge (kiosk account)* — and not
  anyone who has merely been given the lodge role alongside their own: a
  booking officer who also runs the lodge screen is a person with a membership,
  and was quietly losing the cancellation action too. The safeguards that
  matter sit where the decision is actually made, at approval: only a full admin
  may approve a cancellation for an account with admin access, an admin can
  never approve a cancellation they raised themselves, and the club can never be
  left with no full admin — so a sole admin who wants to leave must appoint
  their successor first, and then that successor approves. The review queue now
  says what it is you are approving, marking a participant who holds admin
  access or is an organisation account — "cancel the treasurer" and "cancel an
  ordinary member" used to look identical there — and an approval is refused
  outright if the admin who raised the request has since been deleted, since
  the club can no longer tell that it is a second pair of eyes. Cancelling a
  member no longer needs their roles deleted, so the record of what they once
  did for the club stays intact; the flip side, now written down, is that the
  club cannot delete such a record outright until the roles are removed, and
  that nothing may quietly un-cancel a membership. Related hardening found
  while checking this: the lobby-display preview endpoint now re-checks that the
  admin previewing it still has an active account, which every other admin
  endpoint already did. The member-facing **Membership Cancellation** panel in a
  member's own profile follows the same rule — see the next entry.

- **A full admin, and an organisation account, can now start a cancellation
  from their own profile (#2391).** The **Membership Cancellation** panel in a
  member's profile asked a narrower question than the member page did, and it
  turned away exactly the two kinds of account the member page used to turn away
  before the entry above fixed it: a **Full Admin**, and an **organisation or
  school account**. A departing full admin was told to ring the office; an
  organisation was told the same and had no self-service route at all.
  Committee members were never affected — a Membership Officer, Booking Officer,
  Treasurer, Content Manager or holder of a club-defined custom role keeps an
  ordinary member account underneath their access, so they were always offered
  the panel and always appeared in a relative's family list. Family lists had
  the matching gap for the two classes that were refused: a relative who is a
  full admin, and an organisation sharing a family group, were simply missing
  from the list of memberships you could include, with no reason shown, so it
  looked as though they held no membership at all. The profile panel now asks
  exactly the question the member page asks: is there an account holder here
  with a membership? So a full admin can start their own cancellation, an
  organisation can start its own, and a relative who is a full admin appears in
  the family list and can be included. Two conditions remain, and both are about
  being able to use your own profile rather than about what kind of account it
  is: the account must be active, and it must have its own login. A member with
  no login of their own — most family dependants — is still cancelled either by a
  relative including them in a family request or by an admin from their member
  page, and the refusal now says that instead of implying they are not a proper
  member. The lodge kiosk login and the contact records created by booking
  requests are refused here as everywhere else, because they hold no membership,
  and if one ever appears in a family list it now says so rather than vanishing.
  Nothing about approval changed: whoever raises a cancellation, a *different*
  admin must approve it, and the club can still never be left with no full
  admin — so a sole full admin who starts their own departure from their profile
  must appoint a successor before anyone can approve it.

- **A booking paid in cash — or by a bank transfer that never reached Xero —
  can now be recorded as paid, properly (#2262).** Open the booking, and under
  **Admin tools** you will find **Cash / off-Xero payment**: it shows the exact
  amount owing after any account credit, takes a note for the club's records,
  and asks whether the member should get the usual booking confirmation. The
  booking then becomes Paid and claims its beds exactly as a card payment does —
  it runs through the same locking, the same capacity check and the same ledger
  writes, so a bed can never be admitted into a full lodge on the strength of a
  manual click. Nothing is sent to Xero: no invoice is created, and none is
  emailed to the member for money the club already holds. It is refused, with
  the reason shown, when the booking already has a Xero invoice or has one
  queued (record the payment against that invoice in Xero instead), when it was
  settled as part of a group booking, when there is nothing owing, when the
  booking no longer fits the lodge, or when the amount changed while your screen
  was open. Recorded it against the wrong booking? **Reverse manual payment**
  puts it back to unpaid without cancelling it, while nothing has happened since
  that could not be undone. And if Xero later reports that booking's invoice as
  paid anyway, the club now gets an alert saying the two records disagree,
  instead of the second payment vanishing silently. Cancelling a cash-settled
  booking raises a **Refunds to pay back by hand** task on the Payments page
  rather than pretending a card refund happened: the member is told the club
  will arrange their refund, and the ledger records it at the moment an admin
  marks it paid back. And if the member had saved a choice to put account
  credit towards the booking that was never applied, recording the cash does
  not quietly spend or discard it: the saved choice is cleared, the booking's
  history tells the member their credit was not used and their balance was not
  reduced, and the club is alerted. The dialog warns you about that saved choice
  BEFORE you record anything, so it is never a surprise, and the confirmation on
  screen repeats it afterwards. Reversing the payment puts the saved choice back
  on the booking, so the member can still spend their credit when the booking is
  paid properly. Everywhere those figures are quoted — to the member and to the
  club, on this door and on the card and Xero ones — they are now the member's
  LIVE credit balance rather than the amount they once elected, so nobody is
  invited to refund more than the account actually holds. Recording, reversing
  and closing all need finance edit access and are written to the audit log with
  your name.
- **Emails no longer print the wording notes their authors left behind, or a
  label with nothing after it (#2268).** Thirty-three built-in email templates
  carried instructions to whoever might edit them — `[only when a door code is
  set]`, `[only when reason exists]`, and a whole alternative paragraph on four
  of them — written as ordinary body text. The email engine has no way to act on
  such a note: it substitutes tokens and does nothing else. Because the admin
  email editor pre-fills its box with that built-in wording and saves whatever it
  is given, any club that had customised one of these templates was sending the
  notes to members and admins verbatim. The shipped built-in wording is now all
  clean; a customisation a club saved from the old text still carries its notes,
  so those overrides are now flagged by name on the Email Messages page and can
  no longer be re-saved until the bracketed text is removed. Deleting the notes
  alone would have swapped one defect for another — a lodge with no door code
  would have received a bare `Door code:`, an appeal with no figure a bare
  `Requested:` — so every optional line is now built in full by the code that
  sends it, or left out entirely: twenty such lines across thirty-one templates,
  each with its own token an operator can place in an override. Four templates
  were stating something that was sometimes simply untrue, and those are the ones
  that mattered most: an admin alert said a duplicate card charge had been
  refunded in full even when the refund had failed and only a retry was queued;
  another said a payment link had been emailed to a member when none had been
  sent; a third said a member's own booking was settled and unaffected when it
  was not; and members whose guests' provisional place was cancelled were told
  "your own booking is unaffected and remains confirmed" even when it was not.
  Each now tells the true story on both outcomes, built from the same code as the
  designed HTML version so the two can never drift apart. Alongside that, a
  refund-appeal alert that read `Paid: $$300.00` loses its doubled dollar sign,
  two Xero diagnostic links that appeared as unclickable labels became real
  links, a school-group reminder can no longer begin `'s stay at …` when no
  school name is on file, and an "Account Credit Applied" template that was
  editable but had never been wired to send anything is removed from the editor.
  Every original token stays valid, so a club's existing customisations keep
  rendering and keep saving. Finally, the check that was supposed to catch all of
  this is replaced: it had been comparing each built-in template against a list
  of allowed tokens built from that same template, so it could never fail. Five
  real checks now run on every build, each proved against a deliberately broken
  example — and two of them immediately found further tokens the system supplied
  but the editor rejected, now fixed.

- **A declined refund appeal can no longer be told it was approved (#2321).**
  One email template covered both outcomes of a refund appeal. Its built-in
  wording said the appeal "has been approved" and named the refund amount, and
  the code that sends a *declined* decision reached for the same template with
  no amount to put in it. Clubs on the built-in wording were fine — the designed
  email chose the right words each time — but a club that had customised the
  template sent members whose appeal was turned down a message headed "Refund
  Appeal Approved", containing the sentence "A refund of  will be processed to
  your original payment method". There are now two separate templates, **Refund
  Request Approved** and **Refund Request Declined**, each saying one thing and
  editable on its own. The declined one has no refund-amount field at all, so
  the figure cannot be printed there even by mistake — an override that tries is
  refused when it is saved. Both remain covered by a booking's "No emails"
  switch. If you had customised the old combined template, that customisation is
  not carried across: both new templates start from the corrected wording, and
  the leftover is flagged on the Email Messages page as a stale override to
  clean up, so re-apply your wording to whichever one you want changed.

- **Editing a booking no longer loses your account credit or your promo codes
  (#2266, epic #2245 E2).** Going "back into" a booking — the dashboard's
  Resume button, or Edit Booking on the booking page — lands on a different
  screen from the create wizard, and every credit and promo affordance lived
  only in the wizard. Both now exist on the edit path, built on the wizard's
  own machinery so the two cannot drift. The edit panel gains an **Account
  credit** card (its own card above the Return-method radio, with explicit
  "Credit → booking" / "Booking → you" direction tags): tick **Apply credit to
  this booking** and your choice is saved on the booking (#2265's stored
  election) and applied when you confirm and pay — nothing is taken from your
  balance at edit time, and the booking page reminds you with *"Your $X credit
  choice is saved and will be applied when you confirm."* The panel's promo
  section now surfaces your eligible codes as clickable chips and uses the
  shared promo input, so codes that need you to pick which guests they cover
  work on the edit path too (the in-progress promo lock is unchanged). And
  members can now **edit their own drafts** — Resume previously landed a plain
  member on a page with no Edit button at all. A draft edit commits you to
  nothing: no change fee, no holds, no capacity claim; the confirm/pay doors
  keep enforcing all of that when the draft becomes real. Server-side, the
  modify preview/apply routes accept the election and promo guest selection
  with the same status guards the pay step honours (never on a hold-rail
  PENDING booking, never once money is captured, never on an organiser-settled
  booking), and a credit-only edit is price-preserving by construction — it
  can never reprice an untouched booking across a season-rate change. Review
  hardening in the same change: a draft edit that leaves minors with no adult
  parks the booking for admin review exactly as creating it that way would
  (and the confirm/pay doors refuse an unresolved review outright); a promo
  code's chosen guests are remembered by *who they are*, not by their position
  in the list, so a simultaneous edit elsewhere can never quietly hand the
  discount to the wrong guest; a saved credit choice is never rewritten just
  because your balance happened to dip; and the price summary now shows the
  credit figure the save will actually keep, any slice returning to your
  balance, and the change fee inside "Remaining to pay".

- **Admins can now cancel the membership of a member who has no login of
  their own (#2354).** Opening such a member's admin page used to show no
  **Request Cancellation** action at all — not greyed out, simply absent —
  so their membership looked uncancellable. Most family dependants are in
  exactly this position, as is any adult the club records without giving
  them a login. The cause was the page borrowing a permissions test to
  decide who is cancellable: a member without a login holds no permissions
  by design, so the test always failed for them, while the cancellation
  machinery behind it has always accepted them — an admin-raised request
  is confirmed on the member's behalf and goes straight to the review
  queue, exactly as it does for anyone else. The page now asks the same
  eligibility question the server enforces — is this an active,
  not-yet-cancelled, not-archived member — so the action appears for
  exactly the members it can act on. That question was later widened by
  #2383 above.

- **Self-hosted sites now use whatever processing power the server has free,
  instead of being rationed to a fraction of one core (#2351).** The standard
  deployment recipe used to cap each app container at eight-tenths of a
  processor core. That sounded like plenty, but it isn't: the app rebuilds a
  page's optimised machinery whenever that page hasn't been visited for about
  ten seconds, and that rebuild wants a few seconds of a whole core — more
  than one core if available, since it splits the work across them. Under the
  old cap the rebuild was rationed into small slices, and on a quiet club site
  — where almost every visit is the first one in a while — that turned into
  four-to-thirteen-second page loads that looked like a slow server or
  database but were neither (a live deployment measured exactly this, and
  dropped from over five seconds to about 1.4 the moment the cap was lifted).
  The recipe now sets no cap at all, so pages can spread across every core
  the server has spare — a one-core budget server and an eight-core machine
  both simply use what they have — while the database and the web proxy
  still get a fair, equal share of the processor whenever things genuinely
  compete for it. The deployment guide gains an
  "App CPU sizing" section explaining the arrangement, the measurements
  behind it, how to reimpose a hard cap on a shared server, and two
  mitigations for genuinely starved machines (a keep-warm pinger, and the
  planned pre-rendered public pages of #2352).

- **A custodian can now be given a bed for the season without booking it
  (#2286).** Clubs that keep someone on site all winter had no honest way to
  record it: the custodian had to be given a real booking, usually with a
  100%-off promo code, which put them on the chore roster, counted them in the
  utilisation reports, and left a phantom stay in their booking history. A hut
  leader assignment can now simply **hold one bed** instead.

  Pick the nights and the person as usual, then choose their bed in the new
  **Hold a bed (optional)** step. From that moment the bed is out of the
  bookable pool and off the allocation board for every covered night, with no
  booking anywhere. The default is still **No bed — role only**, which behaves
  exactly as assignments always have and changes no capacity at all — including
  every assignment the nightly auto-assign job creates.

  Members simply see one fewer bed on the availability calendar for those
  nights, with no custodian label anywhere: who is in the building is not a
  member-facing fact. Staff see a hatched **Custodian** band across that bed's
  cells on the allocation board, which is not a drop target and which the server
  refuses regardless, and the lodge screen shows a **Custodian** line in its
  footer while the assignment is running. A custodian who is a minor is never
  named on that screen, at any name-display setting. The in-booking **Bed
  allocation** card (#2252) is told the same facts: it shows the board's
  held-bed notice for the nights on screen, marks any of the booking's own
  placed nights that are somehow sitting on a held bed with the same neutral
  hatched treatment, and its Assign dialog gives the same refusal report the
  board's does.

  The bed is genuinely reserved rather than merely labelled: no guest can be
  placed on it by hand, by the range assign, by the auto-allocator or by the
  lifecycle; and the bed or its room cannot be deactivated or deleted while the
  hold exists. If the bed already has guests on it, or another custodian holds
  it, you are told exactly which nights are in the way rather than having anyone
  quietly moved. If the hold tips the lodge past its capacity you are asked to
  confirm — which is often the right answer, because the custodian really is
  sleeping there; that question lists the nights and, separately, any live
  booking those figures could not count, so you are never confirming a smaller
  number than the real one. Ending or shortening the assignment frees the bed
  immediately, and each row of the assignments table now has its own
  **Release bed** and **Change bed** buttons, so you never have to delete an
  assignment (and its coverage record and kiosk PIN) to hand a bed back. Release
  keeps working even if bed allocation is later turned off, because a bed held
  while it was on still has someone in it. Those buttons also work on the rows
  the nightly job creates, which never come with a bed.

  Everywhere in the admin area the role is called whatever your club calls it —
  the band on the board, the refusal in the range dialog, the picker, the page.
  The lodge TV is the one exception: it prints the fixed word **Custodian** (or
  *Custodians* with a count, on a handover night when two people hold two beds)
  so a visitor reads it without knowing your club's vocabulary. The hold covers the night of the end date itself, so an
  assignment whose dates came from the automatic job (which ends on a guest's
  departure day) should have its end date trimmed by a day first — the form and
  the guide both say so.

- **The club logo is now stored as a real image instead of being baked into
  every page, cutting a multi-megabyte home page down to roughly its content
  size (#2322).** The logo used to be kept as text encoded directly inside the
  page, and the same copy was repeated four times on every public page — in the
  desktop header, the mobile menu, the footer, and once more in the data the
  browser loads behind the scenes. On one club's live site that made the home
  page **5.4MB** and gave it a six-second wait before anything appeared, almost
  all of it the logo. Uploading a logo now sends the file to the server, which
  shrinks it to at most 160 pixels tall and 640 pixels wide — never enlarging
  a smaller one — converts it to a compact modern image format (keeping any
  transparency), and stores it once. Pages then link to that
  stored image the way any normal website does, so browsers fetch it a single
  time and reuse it everywhere and on every later visit. Existing sites are not
  disturbed: a logo saved the old way keeps displaying exactly as before until
  someone uploads a new one, and the kiosk lodge display, the configuration
  export/import bundles, and the admin preview all understand both forms. A
  freshly uploaded logo replaces the old inline copy, and the same rule is
  applied when a configuration bundle is imported, so the two forms can never
  both be set and drift apart. Uploads accept PNG, JPEG, WebP, or GIF up to 2MB — a big
  high-resolution original is fine, it gets resized for you — while SVG is
  refused because scalable-vector files can carry active content. Clubs whose
  logo is still stored the old way are unaffected in every direction: it keeps
  displaying, and they can keep saving colour and font changes normally. The
  old inline format remains accepted for automated callers and configuration
  bundles, now capped at 64KB rather than 900KB, but that cap applies only to a
  logo actually being changed — an existing large one is never rejected just
  because some other setting was edited.

- **The public home page is now cached for logged-out visitors, and the
  website stops re-reading its theme on every request (#2322).** Two changes
  aimed at how long the public site takes to load. First, a logged-out visitor
  asking for the home page can now be served a copy cached for up to a minute
  (and a slightly staler one for up to five minutes while a fresh copy is
  fetched), instead of the site rebuilding the page from scratch for every
  single visitor. Anyone who is signed in is never served a cached page — the
  cache is keyed on the session cookie, so a member always gets their own
  freshly rendered view with the right header. Only the home page is cached,
  and deliberately so: every page that carries a login form, a sign-up form, or
  a one-time link (joining, paying, password resets, chore and family
  invitations, the PIN-gated hut leader instructions) is left exactly as it
  was, because those must never be shared between visitors. The practical
  trade-off is that a style or footer change can take up to a minute to show
  up for logged-out visitors; both admin guides now say so in their
  troubleshooting tables. Second, the public website was re-reading the club's
  colours, fonts and logo from the database on **every** page view, while the
  rest of the site had long since switched to a cached read that refreshes the
  moment the style is saved. It now uses that same cached read, so saving the
  style still updates the site immediately but ordinary page views no longer
  pay for a database round trip.

- **Beds can now be allocated and confirmed from inside a booking, without going
  to the board at all (#2252).** Until now, answering "where is this party
  sleeping, and is it settled?" meant leaving the booking, opening the
  bed-allocation board, setting the date window to that booking's nights, and
  picking its chips out from among everyone else's. An admin viewing a booking
  now gets a **Bed allocation** card on the booking itself — its own section, in
  the section list down the side — with one row per guest: their stay, how many
  of their nights have a bed and how many do not, and each bed they are on shown
  as a run of nights rather than a line per night.

  **Assign…** opens the same range dialog the board uses, prefilled with that
  guest's own stay, so everything it does there it does here — including
  confirming those beds as it writes them. **Remove** takes a run of nights off
  a bed. **Confirm draft beds** approves every draft bed night on that booking
  and, importantly, on no other: the board's existing "approve everything in
  this window" action would have swept up other people's bookings, so confirming
  from a booking now selects by the booking itself. That approval is recorded
  against the booking, so the booking's own **Audit log** link finds it.

  The card is deliberately honest about the things it cannot do or cannot show.
  Confirming beds locks the member out of changing their requested room — and
  under range assignment that lock has usually already happened, so the card
  says so rather than implying the button is the trigger. The lock is also not
  one-way: removing a booking's last confirmed night re-opens the member's room
  request, and the card warns before it does. A stay longer than the 31-night
  window the allocation view allows is shown a page at a time, with the page
  always labelled ("Nights 32–61 of 61") and Confirm stating plainly that it
  reaches the nights you cannot currently see. A booking that cannot hold beds —
  cancelled, deleted, or a status that is never allocated — keeps the card and
  says why, instead of vanishing and leaving you to wonder — and that note is
  about the booking's own status, so it reads the same whatever dates you are
  looking at, and it is no longer swallowed when a cancelled booking still
  carries an old whole-lodge-hold flag. A page that simply holds none of the
  booking's nights says exactly that instead, and keeps the rows and **Confirm
  draft beds** available, because on a long stay its nights are just on another
  page. A booking holding the whole lodge shows the hold instead of rows, with no
  buttons at all, because it needs no individual beds. And because removing a run
  is one night at a time, a removal that stops half way tells you exactly how
  many nights actually went.

  Two smaller pieces of the same honesty: the card's counts and its
  Draft/Confirmed badge say "(this page)" when a stay is paged, because a single
  31-night read cannot report on the rest; and the "this re-opens the member's
  room request" warning counts the whole booking rather than the page, so a long
  stay with confirmed nights on another page no longer gets warned about
  something that is not going to happen. **Confirm draft beds** also stays inside
  the lodge whose beds the card is showing, so it can never confirm a bed you
  were not shown.

  Members see none of this, including on their own booking, and neither do
  read-only admins — every control on the card is a change, and the board is one
  click away for anyone who only needs to look.
- **Members can now ask to book the whole lodge (#2263).** Planning a course, a
  club trip or a family gathering that needs the lodge to yourselves? Book a
  Stay now has a "Need the whole lodge?" card leading to a short form: your
  dates, roughly how many people, who the group is, and anything else the
  booking officer should know. No guest names are needed yet, and an estimate of
  the headcount is fine — the officer confirms the real number with you before
  anything is charged. The ordinary four-step booking wizard is unchanged. This
  is a request, not a booking: nothing is reserved and nothing is charged until
  the officer confirms it, and you can withdraw a request while it is still
  waiting. Requests appear under **My requests** on My bookings, showing whether
  each one is still with the booking officer, approved (with a link straight to
  the real booking), declined, or withdrawn; declined and withdrawn ones are
  removed after 90 days. Two open requests at a time, so the queue stays honest.

  The form deliberately shows no calendar, no "beds left" hint and no price. The
  club's long-standing rule is that a lodge held for one group looks exactly
  like a full lodge to everybody else, and a calendar on this form would give
  that away. For the same reason the confirmation message you get back is the
  same words every time, whatever you asked for and whatever else is booked.

  For booking officers, whole-lodge requests land in the existing booking
  requests queue alongside the school ones, tagged "Member" and "Whole lodge
  requested" — the second tag now shows on school requests too, which it never
  did before. Each one can be expanded to show, officer-side only, how full each
  requested night already is, which nights are already held, and exactly which
  bookings overlap. Set the headcount you are really pricing (and a total price
  if no season rate covers those dates), then approve: the booking is confirmed
  and the whole lodge is held for those nights. Approving never cancels anything
  that is already booked — anything that overlaps is listed for you to sort out
  with the people involved, as it always has been. Declining is one click through
  the usual "email them or not?" prompt; any note you write is kept in the audit
  log for the club's own record and is never shown to the member, who receives
  the same fixed wording either way.

  The money is handled the same way a school booking's is. Approving raises the
  invoice: if your club uses the Xero integration the invoice goes out
  automatically (with any account credit the member is holding allocated against
  it), and if it does not, the club's administrators are emailed to invoice the
  member by hand — including the exact payment reference the member was given, so
  the two match. Either way the member's confirmation email is honest about it:
  it says the booking is confirmed, states the amount still **owing**, and gives
  them the internet-banking reference to pay against. It does not tell them a
  payment has been processed, because none has. The booking page says the same
  thing, and only mentions an emailed invoice when one was really sent.

- **Every dead button in the five guided setup wizards now says why it is dead
  (#2324).** The Xero, Stripe, Google sign-in, Backups and Lodge Display setup
  paths all share one wizard frame, and that frame already showed a **"You have
  view-only access to this area"** banner at the top. What it could not do was
  let the controls inside a step lean on it: the frame calls each step from
  another file, so nothing in the code proved the banner was really above them.
  The result was a split — the Lodge Display steps repeated the reason on every
  button, while the Xero, Stripe, Google and Backups steps had **Save** buttons
  that were simply grey and silent. Both halves are fixed. The frame now vouches
  for its steps, so a control gated on the same access the banner names stops
  repeating it (restoring boards, saving lodge details and pairing a screen; and
  turning nightly backups on and running a verification backup). And every
  control that needs **more** than the banner's access now says so instead of
  saying nothing: entering or replacing the Xero, Stripe, Google and S3
  credentials, the Xero webhook key, the Stripe signing secret, the backup
  destination and Google verification all need **Full Admin**, and each button
  now carries that reason, because an admin who has the wizard's area but not
  Full Admin never sees the banner at all. Turning the Lobby TV display module
  on keeps its own reason for the same reason — it needs system-settings access,
  not lodge access. Nothing about who can do what changed; only what a dead
  button tells you. Three flickering sentences went with it. Two were in the
  Backups wizard — "your admin role can view these settings but cannot change
  them" beside the nightly-backups switch, and "you need support edit access"
  beside the verification button. Both were saying exactly what the banner above
  them already said, and both appeared for a moment even for admins who *can*
  change those settings, because they were keyed off "not allowed yet" rather
  than "not allowed". The third was the "Only a Full Admin can…" notice in the
  Xero, Stripe and Google steps, which appeared and then vanished for actual Full
  Admins, because the page read "still working out who you are" as "not a Full
  Admin". All three are gone or now wait until they know. The published
  banner-coverage figures were re-measured on the merged tree rather than taken
  from either change (again after the in-booking Bed allocation card, #2252,
  added its three, once more when #2286's Release/Change bed controls landed,
  again when the cash / off-Xero payment feature, #2262, landed its four
  per-button-reason controls, and again with #2307's Member guests settings
  card): **310**
  gated admin controls, **261** of them covered by a banner (234 in their own
  file, 27 by a verified vouching parent — 5 of those through the wizard frame),
  and **49** across 26 files deliberately keeping their own reason.
- **Choosing to use your account credit and then saving the booking as a draft
  no longer throws that choice away (#2265).** Ticking "use my credit" in the
  booking wizard and pressing **Save as draft** used to discard the amount you
  chose without a word, and you were never asked again — when you came back to
  pay, the full price was charged and your credit sat untouched. Your choice is
  now remembered on the draft and applied the moment you go to pay, so the card
  is charged only the remainder. Nothing is taken from your balance while the
  booking is still a draft: if you abandon it, delete it, or let it expire, your
  credit is exactly where you left it. If your balance has changed in the
  meantime — you spent some of it on another booking, or you edited the draft to
  a cheaper stay — as much as is still available and still owed is applied, and
  the pay step reports what was applied and why it fell short rather than
  quietly using less. A booking your credit covers in full is now simply
  completed and confirmed at no charge instead of getting stuck at a payment
  page it could never pass — as is a draft that was repriced to nothing while
  you were looking at it. Choosing to pay by internet banking works the same
  way: your credit is applied first and the invoice asks only for the
  difference. And if the club held your booking for review before it could be
  paid, your choice now survives the wait instead of being dropped while an
  administrator decided.
  In the rare case where a booking gets paid in full before the credit can be
  applied — an invoice that had already gone out at the full price, for instance —
  your credit is left untouched on your account and the booking's History now says
  so in plain English, with the club told at the same time so they can refund the
  difference if you would rather have it back. And a public payment link no longer
  charges the full price on a booking with a saved credit choice: it asks you to
  pay from your own bookings page instead, where the credit is applied.
- **A guest can now be put in one bed for a whole long stay in a single action,
  and the board can be browsed a month at a time (#2251).** The bed-allocation
  board shows 31 nights at once, and until now that was also as far as you could
  assign: a long stay meant dragging a guest onto a bed, moving the dates,
  dragging again, over and over. Every guest awaiting a bed — and every guest
  already placed on the board — now has an **Assign range…** action. Choose a
  bed, a first night and a checkout date of any length (up to a year), and the
  whole stay is written in one go.

  It is deliberately all-or-nothing. If any night in the range is blocked,
  **nothing is written at all** and you are shown exactly which nights and why,
  split into three kinds that are never lumped together as "skipped": the bed is
  already taken that night (the occupying guest is named, and an occupant whose
  booking does not hold the night is badged **Provisional** — still a clash, so
  nothing is overwritten behind your back); the guest is not booked that night,
  which is not a clash at all but a sign the range or the guest is wrong; or this
  booking itself holds the whole lodge, which needs no individual beds. Only
  then, and only if you click the second button, does it write just the free
  nights — it says how many before you commit, and writes exactly those, refusing
  again with a fresh list if one of them has been taken in the meantime. If any
  night was refused because the guest is not booked on it, that button asks you to
  confirm first: it names how many nights are not part of the guest's booking and
  will not be assigned, and how many will, and waits for a **Yes**. That refusal usually means
  a typo in the dates, so going past it is something you read and agree to rather
  than a click next to a warning. Either
  way the operation leaves a **single** audit entry against the booking recording
  the range you asked for, what was written and what was refused, so "who put
  this guest in bed 4 for the winter?" has one answer rather than fragments. The
  entry records dates and counts rather than other members' names, which stay on
  your screen. If moving the guest left a partner alone on a shared double, all of
  those promotions are recorded together in one further entry rather than one
  entry per night. Assigning a range
  confirms those beds immediately, which locks the member out of changing their
  requested room; the dialog says so before you commit. Afterwards the board
  tints the nights it wrote green and the nights it refused red so any gaps are
  easy to spot.

  The board itself gains **‹** and **›** arrows that step the window a calendar
  month at a time, and it no longer quietly shortens a date range you type: a
  window longer than 31 nights is refused with an explanation instead of
  silently showing you something narrower than you asked for. Arriving from a
  long booking's link, the board shows the first 31 nights and tells you it is
  showing part of the stay. Finally, hand-placing a guest from a booking that
  holds the whole lodge is now refused outright, matching the automatic
  allocator (#2285) — previously such a placement was accepted and then quietly
  cleaned away later.

- **The booking-confirmed email now explains a promo that raises the price,
  instead of a blank Discount line and an unexplained total (#2267).** A member
  who booked with an exclusive-use flat-rate promo received a payment
  confirmation whose Discount line trailed off after a minus sign, whose
  authoring notes (`[only when …]`) rendered as body text, and whose subtotal
  and total differed by $1,370 with nothing in between to say why — nothing was
  mischarged, but the one token that could explain a price-*raising* promo was
  not usable in the admin-editable body. The editable booking-confirmed body
  now uses a single pre-composed `{{promoSummary}}` token that renders the
  whole story — `Subtotal:` plus a signed `Promo adjustment (CODE):` line,
  `-$30.00` for a discount and `+$1,370.00` for a surcharge — and renders
  nothing at all when no promo applied, so there is never a ragged or empty
  line. The flat body and the built-in HTML email now build that block from the
  same code, so their money stories cannot drift apart again, and a test matrix
  (discount, surcharge, no promo, door code set and unset) renders the shipped
  default body end-to-end — through the same layout a member receives — and
  fails on any line that trails off after a `-`, `+`, `–` or `:`. The door code
  travels the same way: the body carries a pre-composed `{{doorCodeNote}}`
  line, so a club that records no door code no longer emails a bare
  `Door code:`. The booking-modified default body loses its 13 bracket
  annotations the same way: a pre-composed `{{changeSummary}}` block, built by
  the same code as the built-in HTML email, lists only what actually changed —
  `Previous`/`New` pairs where something moved, a single line where it did not,
  and a change fee only when one was charged — and the additional-payment story
  arrives through the existing pre-composed `{{paymentNote}}`. That email also
  names the change in words on both paths (a batch edit used to reach members
  as the raw word `BATCH_MODIFY`). Admins can now also use
  `{{promoAdjustment}}` (the signed value) in overrides — and the editor now
  refuses a body that types its own `+` or `-` in front of it, explaining that
  the token already carries its sign — while older overrides that reference
  `{{subtotal}}`, `{{discount}}`, `{{promoCode}}`, `{{doorCode}}` or the
  per-piece `Previous`/`New` tokens keep rendering and re-saving exactly as
  before. Showing members the promo explanation is now **required** in a
  booking-confirmed override, satisfied any of three ways — `{{promoSummary}}`,
  the signed `{{promoAdjustment}}`, or the older `{{discount}}` the previous
  default body used — so no override a club already saved is invalidated, while
  an override that deletes the explanation altogether is refused instead of
  quietly leaving a charged member with a total and no reason for it. (A
  `{{subtotal}}` line on its own does not count: a subtotal with no adjustment
  beside it is the confusing email this whole fix is about.) The editor now
  prints that rule, and the tokens that satisfy it, under the token chips. When
  a saved override is rejected, the editor also shows the specific reasons
  instead of a bare "Invalid email template". Only clubs that saved an
  override of these templates ever saw the broken email; clubs on the defaults
  always got the correct built-in HTML version.

- **Setting up a lodge TV is now one guided path instead of five cards and a
  guess (#2249).** **Admin → Lobby Display** leads with a **Guided setup** card
  whenever your club has no boards or no working screen, and it opens a six-step
  wizard that takes you from "the Lobby TV display module is off" to a TV in the
  lodge showing the right board: turn the module on, make sure the built-in
  boards exist (running the same **Restore built-in boards** action, with the
  same warning about what it overwrites), pick the board and preview it as the
  lodge will see it, fill in the handful of values the board prints — Wi-Fi name
  and password, checkout time, door code, and the on-screen notice — then pair
  the screen by typing the six characters it shows. The wizard creates the
  screen record, binds the board you picked and arms the pairing in one press —
  and then waits with you: while it is waiting for the TV to claim the code, and
  again while it is waiting for the screen to fetch its first board, it re-reads
  your screens every few seconds and ticks itself over, with a **Check again**
  button for when you would rather not wait. One screen record is created no
  matter how many times a code is mistyped, and if the board could not be
  assigned it says so instead of promising a board the screen is not showing.
  The order is deliberate: you finish the authoring first and hang the TV last.
  Every step checks the real state of your club rather than what you typed, so
  you can leave, come back, or re-run the whole thing after replacing a TV
  without undoing anything — and the final step only ticks once the screen has
  actually fetched its board, which is the only real proof the whole path works
  rather than just the admin half of it. Two things are said out loud rather
  than left as surprises: where you got to is saved for the **whole club**, not
  for you personally, so another admin resumes from the same step; and turning
  the module on needs system-settings access, so an admin with lodge access only
  is told who to ask instead of being handed a button that would be refused. The
  wizard is the one Lobby Display page that stays open while the module is off —
  everything else there still 404s until it is on — and once your screens are
  live it steps back from the gold lead card to an ordinary card in the hub, and
  stays named in the **Help** panel on every Lobby Display page.

- **A member's admin page now draws the whole family as a read-only tree
  (#2253).** In the Family section — under the family-group chips, above the
  billing family and parent link cards — the page works out how everyone
  connects from the links the club has already recorded (parents, second
  parents, confirmed partners) and follows them across households, so
  grandparents, siblings, half-siblings, cousins, and a dependant's other
  parent all appear, each drawn once. It reaches three generations above and
  below the member being viewed (four counting the member's own), the same
  limit parent links themselves are capped at. Relationships that are not
  stored anywhere are marked **Derived** with a dashed outline, so a worked-out
  sibling is never mistaken for a recorded claim — and half-siblings are
  separated from full siblings by *which* parents are shared, not how many,
  with the tree saying plainly when that verdict comes from a missing record
  rather than a different parentage. Where a child's club email goes to someone
  further up the family than their own parent, the tree says so in words and
  names the person — unless the mailbox belongs to a member outside the family
  altogether, which it reports without naming anyone. Archived relatives stay
  in the tree, badged, with their contact details left off, rather than
  silently vanishing and making a grandparent look unrelated. Where a family is
  too tall or simply too large to draw in full, the tree says which, instead of
  quietly ending. Nothing in the tree can be edited: it is a picture of the
  Parent Links, Partner, and Dependents cards below it, and changing those
  changes the tree.
- **Exclusive whole-lodge bookings no longer collect hidden bed assignments
  (#2285).** A booking with an exclusive whole-lodge hold takes the entire
  lodge, so nobody in the group is assigned an individual bed — the
  bed-allocation board has always treated it that way, showing a single
  "exclusive hold" banner instead of per-bed chips. But behind the scenes the
  automatic allocator kept assigning real beds to the group anyway, every time
  the booking was touched. Those assignments were invisible on the board (so
  an admin could neither see nor correct them) and could clash with or
  reshuffle other bookings' beds once the hold was removed. Now the automatic
  allocator follows the same rule as the board: a held booking gets no bed
  assignments, and any it already carries are cleaned up the next time
  anything about the booking changes — no manual tidy-up needed for bookings
  affected in the past. Setting a hold now also clears the booking's existing
  bed assignments immediately, and removing the hold re-plans the group's beds
  right away, so the booking comes back as an ordinary one in a coherent
  state. Approving a school's request for sole occupancy cleans up the
  converted booking's bed assignments the same way. Because that clean-up
  deletes real work, the admin screens now say so before and after: the
  confirmation box for setting a hold warns up front that the booking's
  existing bed assignments — including ones placed by hand or already approved
  — will be removed, the box for clearing one explains that beds are re-planned
  automatically (and that other bookings' provisional placements may move), and
  the confirmation message afterwards reports how many assignments were removed
  or re-planned. The removed assignments are written into the audit log in full,
  so a hold set by mistake can be undone by hand. A dedicated test now keeps
  the board and the automatic allocator in agreement so they cannot drift
  apart again.

- **Every hand-written "open in Xero" link on the admin screens now lands in
  the club's own Xero organisation (#2283).** Twenty-one links across ten admin
  screens — member records and the members table, payments, subscriptions, and
  the Xero Sync panels — were plain Xero web addresses that did not say *which*
  organisation they meant. For an admin whose Xero login can see more than one
  organisation (an accountant, or a treasurer for two clubs), Xero answers such
  an address with whichever organisation they last had open, so a link could
  quietly open **another organisation's books**. All of these links are now
  built the same way as the Xero Sync page's "Go to Xero" button: for an admin
  with finance access, when the club's Xero connection is healthy they carry
  the organisation's short code and Xero switches to the right organisation
  before showing the page; otherwise they fall back to the plain address — the
  link always works, it is just less precise. Links that Xero sync itself
  recorded earlier (the ones shown against a record's Xero activity, the sync
  operations and inbound event lists, and suggested or duplicate contacts) are
  **not** covered yet and still open in the last-used organisation; deciding
  how those should work is tracked as #2314. A new automated check stops future
  code from reintroducing an unqualified hand-written Xero link. Behind the
  scenes, the read of the organisation's financial year-end month (used to
  default the membership year) no longer retries against a rate-limited Xero
  connection: it degrades immediately, reuses the year-end month already known
  from the connection summary instead of silently falling back to March, waits
  a few seconds before trying Xero again so a struggling connection is not made
  worse, and an admin re-checking the connection still gets a live read
  straight away.
- **Writing a Lodge TV footer or CSS override no longer means remembering the
  tokens (#2248).** Every field where a board's HTML or CSS is typed by hand —
  the Visual builder's **Footer HTML**, **CSS overrides** and a zone's **HTML
  block**, and the CSS and footer fields on the advanced **Templates** page —
  now carries a small **Insert token** button on its label row. It opens a
  searchable picker listing only what that field actually accepts: on an HTML
  field, the standard tokens (`{{lodge-name}}`, `{{display-date}}`) and the
  preview lodge's saved `{{config:…}}` keys, each row showing the value
  currently saved on that lodge — so you pick "the Wi-Fi one" rather than
  remembering a slug — plus a free-text path that turns anything you type into
  `{{config:<your-key>}}`; on a CSS field, the board's own
  `var(--display-…)` palette and the club theme colours, inserted ready to
  use. The token lands exactly where your cursor was, replacing any selected
  text — never tacked onto the end — and focus returns to the field with the
  inserted token selected, so you can keep typing or type over it. A key with
  no value saved yet can still be inserted: the picker warns, before you press
  Enter, that the wall will show a visible `⟨config:key?⟩` placeholder until
  the value is filled in on the lodge's display settings, and a key that
  breaks the naming rules is refused with the rules (and a fixed-up
  suggestion) instead of silently inserting something the screen would never
  match. The whole picker is keyboard operable, the existing explanatory text
  under each field stays put, and one shared component drives all five
  fields so their behaviour cannot drift apart.

- **The lobby display's built-in boards can be restored on a club that never
  got them, and the three words the screen uses are finally defined (#2247).**
  A club whose database was created before the lobby display existed had none
  of the seven boards that ship with the app: they are only ever created when
  the database is first seeded, and upgrading does not re-do that. The Templates
  gallery simply sat empty and said nothing. It now says which of the three
  things is actually true — the **Lobby TV display** module is switched off,
  your admin role cannot see display templates, or the boards were never
  created — and where the boards are missing, **Restore built-in boards**
  creates all seven in one press. Pressing it again is safe, and if the
  database fails part-way the whole restore is rolled back rather than leaving
  half a library. It asks first, because it is a genuine restore: every
  built-in goes back to the design that ships with the app, so a change made to
  a built-in in place is undone — including one that arrived in an imported
  configuration bundle. Layouts and templates saved under your own names are
  never touched, though a board of yours built on a built-in layout will follow
  that layout's restored shape; screens keep showing whatever they already
  show; and who pressed it, with the seven names it rewrote, is written to the
  audit log. It is deliberately a button rather than something the upgrade does
  by itself — running it automatically would quietly undo a club's edits to a
  built-in every release.
  Relatedly, the seven built-in names are now **reserved**: saving a layout or
  template of your own under one is refused, with a message saying why. They
  were never protected on a club that had no built-ins yet, which is exactly
  the club this feature is for — so a board could be built under one of those
  names and then be silently overwritten by the very restore that promises not
  to touch your work.
  The same screens used three words for two things and explained none of them.
  A **Layout** is the shape of a board, a **Template** is that shape filled in
  and is what you point a screen at, and a **board** is what the screen actually
  shows: a Template on its Layout, for the lodge that screen belongs to. Those
  three sentences now appear, in the same words, on the Lobby Display hub cards,
  on the Reference page, on the Visual builder, and in the operator guide.

- **Families can now be recorded across four generations, not two (#2255).**
  A member who already had dependants could not be recorded as anyone's child,
  so a grandparent, parent and child could not all be linked in one line — the
  club had to leave a real relationship unrecorded. Parent links now run up to
  **four generations** (great-grandparent, grandparent, parent, child), still
  with at most two parents each. The limit is checked when a link is made, from
  both ends at once, so it no longer depends on the order the links happened to
  be created in — which is worth saying plainly, because the old "two
  generations" rule did depend on it: it refused to attach a member who had
  dependants, but never looked at the parent's own parents, so a longer chain
  could be built downwards one person at a time and nothing stopped it. Every
  place that creates a parent link now enforces the limit, including admin
  member-create, family-group child requests, membership-application approval,
  and **merging two duplicate member records** — four paths the old rule never
  covered at all. (Merging is the surprising one: it never creates a link, but
  joining two records joins their families, which could produce a six-generation
  chain or link a family back on itself. Such a merge is now refused, and asks
  you to unlink first.) A link that would make the chain longer, or that would
  loop a family back on itself, is refused with an explanation naming the limit.
  **Where club email goes** follows the family further too: if a dependent
  inherits their parent's email address and that parent has no real address of
  their own, the club now uses the nearest person above them who does, instead
  of leaving that generation's children unreachable. Both the member's admin
  page and the family's own profile page say whose address is being used when it
  comes from beyond the direct parent, since that is the family whose consent is
  at stake. When a young member reaches adult age and gets their own login,
  their children's notifications now follow them instead of staying with the
  grandparent. **Removing a member** — cancelling, archiving, approving an
  account deletion, or hard-deleting the record — now tells you what it
  detached: their own dependants are
  left without a parent link (they are deliberately not moved up to a
  grandparent, because who is responsible for a member is not something to
  change automatically), and both they and anyone who was receiving email at the
  removed member's address are listed on screen and in the audit log. Approving
  a deletion also stops club email being sent to the anonymised address, which
  it previously kept attempting forever. Who is **billed** is unchanged by the
  link rules themselves: parent links record responsibility and grant no fee
  coverage, which comes from family groups and membership types as before. There
  is one indirect route worth knowing about, though — approvals that add someone
  to a family GROUP still change that group's composition, and group composition
  is a fee-model input, so an approval that was previously refused can now
  compose a group the fee rules classify as a Family.
- **Recording a membership payment by hand now asks whether to tell the member
  — and can actually tell them (#2260).** When a treasurer marks a member's
  subscription paid for a cash, cheque or internet-banking payment, the club
  had no way to send that member any acknowledgement: the action wrote the
  status and emailed nobody, ever. It now offers the club's usual choice.
  "Mark paid and email member" sends a short receipt — the season, the amount
  (only where the club has a recorded fee amount for that season), and the date
  it was recorded. "Mark paid without emailing" records the identical payment
  and tells nobody. The subscription is marked paid either way, and which way
  the treasurer chose is written to the audit log, so a later "did we tell
  them?" has an answer. Because a manual payment is cash the system never saw,
  the receipt never invents a figure: it shows an amount only where the club has
  one recorded for that member alone, and leaves it out otherwise. A family
  membership fee is deliberately left out — that figure is the whole family's
  bill, and telling one member it was recorded against them (with "nothing
  further to pay") while their relatives still owe theirs would be worse than
  saying nothing. It mentions no invoice, no payment link and no Xero
  reference, because manual mark-paid only exists where there is no invoice.
  The message the treasurer gets back says what actually happened rather than
  what was asked for: a receipt "is being emailed" only if it really was handed
  over for sending, and there is a plain "the receipt could not be sent" when
  the member's address cannot receive it. The payment stays recorded either
  way — a failed email never quietly undoes it.
  Reversing a manual payment never emails the member — there is no
  "your payment was un-recorded" notice worth sending.
  The confirmation itself is now a proper dialog with a note box, replacing the
  three bare browser pop-ups this action used to rely on (including the one
  where cancelling the note prompt silently abandoned the whole action).

- **"No emails" is now something an officer can actually switch on, and the
  booking says what it cost (#2259).** The mechanism landed in #2258; this is
  the part an officer touches. The switch sits in the **Admin tools** card on a
  booking, and turning it on opens a dialog that states the consequence in plain
  words — no emails at all for this booking, including cancellation notices and
  payment reminders, and you are responsible for telling the member yourself —
  with a button that says exactly that. It is deliberately not a tick-box you
  can skim past, and nothing is saved until it is answered. If the booking is
  holding a live waitlist offer, the dialog says so before you confirm: that
  offer was emailed before the switch went on, so the member **can still accept
  it** and the bed must not be reassigned — what they lose is the expiry
  warning and the confirmation if they accept, so an officer has to follow it
  up. If the booking is still waitlisted with no offer yet, the dialog says
  that instead: while emails are off it is passed over when beds are handed
  out, keeps its place in the queue, and holds nobody else up.
  Once it is on, the booking carries a standing warning listing what was
  actually withheld — each kind of message by name, how many of it, its
  subject, and when the most recent one would have gone out — including the
  invoice email Xero would have sent. Grouping by kind is deliberate: a week of
  chore-roster emails for a large party is dozens of near-identical records,
  and listed flat they would bury the one cancellation that matters. Two kinds
  carry a link rather than information and each says what to do about it: the
  split-guest payment link was never generated, so clearing the switch is
  enough and it re-sends itself; the chore roster replaced the guest's working
  link before the email was withheld, so that guest currently has nothing that
  works and an officer has to re-send the roster by hand. The banner also
  points at the email-failure queue, since it
  lists only what was withheld deliberately and not what failed for other
  reasons. It keeps showing after the switch is turned back off, in amber
  rather than red: turning emails back on re-sends nothing, so a member who
  was never told about a cancellation is still never told.
  Every admin action on that booking that would normally ask "email the member
  about this?" now stops asking. With the switch on the message is withheld
  whichever button is pressed, so the question was misleading — it invited an
  officer to choose "and email member" and walk away believing the member had
  been told. Confirming pending guests, editing, cancelling, approving or
  declining a review, force-confirming from the waitlist, and deciding a refund
  appeal all now say plainly that emails are off and carry on without sending.
  The chore-roster send is unchanged, because it goes out per night across many
  bookings at once; a silenced booking's own roster email is still withheld
  individually.
  A member sees no sign of any of this — not the switch, not the warning, and
  no value in the page's data that varies with it. The page they are served
  carries no trace of the setting at all, not even an empty one.

- **A booking can now be put on "No emails", and the system withholds
  everything about it (#2258).** Sometimes the club needs a booking to be quiet
  — a member who has asked not to be contacted, a booking being sorted out by
  phone, a test or duplicate an officer is cleaning up. Turning "No emails" on
  for a booking stops every message the system would send about that stay:
  confirmations, changes, payment notices, reminders, arrival information,
  cancellations, waitlist offers, chore rosters, and even the invoice email Xero
  sends on the club's behalf (the invoice itself is still raised in Xero — only
  the emailing stops, so an officer can still send it by hand). Turning it on
  requires an explicit acknowledgement that the member will not be told, and who
  turned it on and when is recorded.
  Three things it deliberately does NOT do. It never touches sign-in security
  mail — two-factor codes, password resets, sign-in links and email-change
  notices always go through, because the switch is tied to the booking and never
  to a person's email address; silencing those would lock a member out of their
  own account. It never silences the club's own admin alerts, so an officer is
  still told when a payment fails. And it never guesses: if the system cannot
  read the setting for any reason it withholds the message rather than risk
  sending one that was meant to be held back, and tries again later.
  Everything withheld is recorded against the booking, so the booking page can
  show a standing warning listing exactly what was not sent. A booking on "No
  emails" is also skipped when waitlist places are handed out, so it is not
  offered a bed it would never hear about, and the waitlist board shows such an
  entry as deliberately silenced rather than as a failed email. Turning the
  switch on does not withdraw an offer the member has already been made — the
  waitlist board flags that booking for attention until someone sorts it out.
  Turning the switch back off restores normal mail from that point on; it does
  not re-send anything that was withheld.
- **Example text in admin forms no longer looks like an answer somebody already
  typed (#2257).** Fields such as Season Name, Promo Code, Chore Name, Group
  Name and Banner Message used to show their example inside the box in grey —
  "e.g. Winter 2026" — which reads as a value the form has already accepted.
  Those examples now sit as a short line of helper text UNDER the field
  ("Example: Winter 2026"). That means the example stays visible while you type
  and after the field is filled in, instead of disappearing at the first
  keystroke, and it can now sit alongside a validation error or a "you can view
  this but not change it" note rather than competing with them — where a field
  has more than one of those, the error or the view-only note is announced
  first. Placeholders still shown in fields built on the shared input, textarea,
  search and drop-down components — instructions like "First name", format
  samples such as "member@example.com" or "0.00" — are now drawn in italics so
  they read as prompts rather than as content. A handful of admin fields use
  raw browser inputs and keep the browser's default placeholder look for now;
  they are part of the #2264 sweep. Drop-down buttons that said "Select item…" were the worst offender:
  they were drawn in ordinary text colour, identical to a real selection, and
  are now styled as placeholders too. Reviewing the remaining placeholders
  across the rest of the app is tracked separately (#2264).

- **Dates no longer change shape (or day) depending on whose computer is
  looking at them, and the family-group "Edit" button visibly does something
  (#2256).** A handful of screens printed dates using whatever the *viewer's*
  own computer was set to instead of the club's settings. On a machine set to
  United States English, "16 Apr 2026" came out as "4/16/2026"; on a machine in
  a time zone behind New Zealand it could come out as the day *before* the real
  one. The affected places were the family-group request queue (the "Requested"
  stamps and every date of birth on a review card), the family-groups list
  (partner-invite expiry dates and the "Created" column), the induction records
  (sign-off and completion dates, on screen and on the printed sheet), and the
  Xero settings page's "cache last refreshed / expires" line. The
  card-setup-failed email had the same problem in a quieter form — it named the
  right country but not the right time zone, so the stay dates it quoted
  depended on where the sending server happened to be. All of these now use the
  club's own date settings, so everyone sees the same date, written the same
  way, wherever they are. Chore-roster emails are deliberately unchanged: they
  keep their long "Wednesday, 15 July 2026" wording.
- **Family groups: pressing the edit (pencil) icon on a group — or New
  Group — used to look like it had done nothing (#2256).** Both forms open in
  the same place: below the search bar and the two queue cards, and *above* the
  list of groups. So if you scrolled down to a group and clicked edit, the
  editor opened off the top of the screen; and with a busy queue, New Group
  opened the form well below the button you had just pressed. Either way
  nothing you could see changed. The page now scrolls to the form and puts the
  keyboard cursor in it every time it is opened — including when you re-open
  the same group you were just editing, which previously did nothing at all.
  The group you are editing is highlighted in the list and badged "Editing"
  until you save or close, and closing puts the keyboard cursor back on the
  button you started from. Nothing about who may edit a group has changed.
- **"Add Dependant → Link Existing" now finds the members it was hiding, and
  says why when it still finds nobody (#2254).** Searching for an existing
  member to link as a dependant reported "No eligible members found" for almost
  everybody: the search silently dropped every member who had no parent recorded
  — the overwhelming majority of valid candidates — so admins could not link an
  existing member at all without first giving them an unrelated parent. The
  search now returns those members. When a search genuinely has no one to offer,
  the dialog no longer stops at a bare "not found": it lists the members whose
  names matched and the reason each cannot be linked ("already has two parents
  recorded", "is archived", "is already linked to this member"), and only says
  "No members matched your search" when nobody matched at all. The search and
  the save step are now driven by one shared rule, so the dialog can no longer
  offer a member that saving then refuses, nor hide one that saving would have
  accepted. Who may be linked was unchanged by this fix — at most two parents, no
  linking someone who already has dependants of their own, no archived members —
  and inactive members remain linkable, badged "Inactive", as before. (The
  "already has dependants" part of that was then replaced in the same release by
  the four-generation limit above, which also added a "would make the family
  chain more than 4 generations deep" reason to the same list.)
- **Fixed: after switching the connected Xero organisation, the club's financial
  year and period-lock checks could keep using the PREVIOUS organisation's
  settings (#2261).** The app remembers a few things it reads from Xero — the
  organisation's financial year-end month, its name, and its accounting lock
  dates — so it does not re-ask Xero on every page load. Connecting or
  disconnecting Xero already cleared that memory. What it did not handle was a
  read that was *already underway* at that moment: it finished a fraction of a
  second later and quietly re-filled the memory it had just been cleared from,
  with the old organisation's answers.
  The financial year-end month is the one that costs money. It decides which
  membership season a date falls in, how a part-year subscription is charged,
  and which window membership invoices are searched over. Refilled with the
  wrong month it would have stayed wrong for up to 12 hours: a $200 annual fee
  worked out on a mid-May decision date comes to roughly $183 under a June
  year-end but roughly $33 under a March one — the same member, the same date,
  five times the difference. The accounting lock dates matter for the same
  reason in the other direction: they are what stops a backdated booking being
  invoiced into a period the accountant has already closed, and stale ones could
  let such a booking through. Both now refuse to save an answer that arrived
  from an organisation the club is no longer connected to, so the next read goes
  back to Xero and gets the right one. Nothing changes for clubs that have not
  switched Xero organisations; there is no configuration to update.

- **A "Go to Xero" button in the Xero Sync page header (#2261).**
  When an admin spots a problem on **Admin → Finance → Xero Sync** they can now
  jump straight into Xero from the page header instead of hunting for a Xero
  tab. It sits in the header rather than inside a section, so it is there
  whether or not the Health Snapshot is expanded. Where the club's Xero
  organisation can be identified the link opens *that* organisation's
  dashboard — which
  matters for a login that covers several Xero organisations. Where it cannot,
  or Xero is not connected here, the button becomes a plain **Log in to Xero**
  sign-in link rather than disappearing or greying out, since opening Xero is
  exactly what is wanted when the connection is broken. The organisation
  identifier Xero URLs need comes from the existing organisation lookup, which
  is cached on the server: the first page load after a restart, after 12 hours,
  or after connecting/disconnecting Xero costs one extra Xero API call, and
  every load after that costs none. While that lookup is failing it is retried
  at most once a minute rather than on every page load, and the button says
  only "Opens Xero in a new tab" until the lookup settles — it never blames a
  failed read for a link that is still loading.
- **A member put on somebody else's booking can now take their own place off it
  from the booking itself, and the "already booked on those nights" message
  finally says what to do (#2250).** The self-removal action already existed, but
  the only way to reach it was to start making a clashing booking of your own and
  find the button on the wizard's conflict card — so most members never knew it
  was there. The booking page now shows a short card to a member who is a guest
  on someone else's booking: it says whose booking it is, offers "Remove me from
  this booking" behind a confirmation, and — when the removal is not allowed —
  hides the action and states the reason instead (the stay has started, the
  booking is no longer in a changeable state, you are the only person on it, or
  the club priced the booking as a quote).
  Eligibility is decided by one shared server-side rule, the same one the removal
  service enforces, so a member is never shown a control the server would refuse.
  The clash message itself was rewritten to name the nights, address the member
  directly when the clash is their own place, and state the next step they can
  actually take: an admin approving a booking request no longer reads advice to
  "choose different dates", which only the person picking the dates can act on.
  Nothing about who may remove whom has changed — only the owner, an admin, or
  the person themselves can take a place off a booking, and the owner is emailed
  and their total updated exactly as before.

- **The "already booked on those nights" refusal no longer tells you about a
  booking you are not part of (#2250).** A member can legitimately have a family
  member who is a guest on a stranger's booking. Asking for a price on clashing
  dates used to return that stranger's full name, the whole span of their stay,
  and the booking's id — none of which the member could see anywhere else in the
  app, and none of which was ever shown on screen. The refusal now carries only
  who in your own party is already booked and which of your chosen nights clash.
  Where you ARE entitled to the detail — it is your own booking, you are the
  person double-booked, or you are an admin resolving the clash — nothing
  changes, so the admin booking-request linking warning still shows the owner and
  their dates as before.

- **The Lodge TV Visual builder's Live preview works again (#2246).** Clicking
  **Live preview** in the builder showed a "Content blocked" error instead of the
  board. The builder embeds a sandboxed frame of the display page, but the
  app's own content-security policy granted that permission only to the separate
  full-screen preview page, so the browser blocked the builder's frame. The
  permission now covers both preview surfaces, matched on the exact page address
  so no other admin page gains it. Because a page's security policy is fixed the
  moment the browser loads it, the two in-app links into the builder (the
  **Visual builder** card on the Lobby Display page, and the "visual builder"
  link on the Layouts page) now load the page fresh rather than switching to it
  in place — otherwise the builder inherited the previous page's policy and the
  preview stayed blocked. The same "load the page fresh" requirement applies to
  every page that has its own security policy, so the automated check that
  guards it is now driven from the list of such pages: adding a page to that
  list fails the build until its links load the page fresh too, instead of the
  page quietly not getting the policy it asked for.
- **The reverse proxy no longer contradicts the app about which pages may be
  framed (#2246).** The web server in front of the app told browsers "never
  frame any page", overriding the app's own "the display board may be framed by
  our admin preview". The previews worked anyway only because browsers are
  required to prefer the app's newer-style policy when the two disagree — so the
  feature depended on a browser tie-break rather than on the site actually
  saying what it meant. The web server now says the same thing the app does: the
  display board may be framed by this site, and **every** other address —
  including the legacy finance dashboard and uploaded images, which the app
  itself does not cover — is still guaranteed unframeable at the edge.
  **Operators: this one needs a manual step.** The change is in `Caddyfile` and
  `Caddyfile.staging`, which are *not* applied by an app deploy. After taking
  this release, reload Caddy on the host — `docker compose exec caddy caddy
  validate --config /etc/caddy/Caddyfile` then `... caddy reload --config
  /etc/caddy/Caddyfile` (a graceful, zero-downtime swap). See `DEPLOYMENT.md`.
  Until you do, nothing breaks — the previews keep working on the browser
  tie-break exactly as they do today.
- **Postgres connection ceiling raised from 30 to 40 to stop intermittent
  `FATAL: sorry, too many clients` when a deploy or backup overlaps normal
  load.** At `max_connections=30` the app's connection pools already summed to 27
  during a blue/green deploy window (two web slots + the cron leader + the
  migration step), leaving almost no room for the other things that open their
  own database connections — the nightly `pg_dump` backup, the deploy-time shadow
  database, the health probe, and operator `psql` sessions. When those
  overlapped, Postgres refused new connections and could lock operators out of
  the database. The ceiling is now 40 (the database container's `mem_limit` is
  raised 512m→768m to match); the per-container pool sizes are unchanged. This is
  a shared default, so every deployment gains the extra headroom, and it takes
  effect the next time the database container is recreated (any deploy).
  Operators of very small hosts can lower both values together — see
  `DEPLOYMENT.md` "Connection pool sizing".

- **Image and configuration uploads can no longer be used to exhaust server
  memory (#2235).** Every upload form (member photos, the website image library,
  the Image Manager, and configuration-bundle import/preview/reseal) now reads
  the request body through a shared streamed, size-capped reader instead of
  buffering the whole upload into memory first. Previously a signed-in user could
  send a very large upload with a missing or understated size header and force
  the server to hold the entire body in memory before the real limits applied;
  the new reader stops reading the moment an upload exceeds its limit and rejects
  it. Valid uploads are unchanged: the same file types and per-file size limits
  apply, and the Image Manager still uploads several files at once (now capped at
  25 files and 80MB per batch). A file of *exactly* the size limit is still
  accepted (the caps are inclusive maxima, as before); only a file over the limit
  is rejected. When a batch is refused, the message now names the specific limit
  that was hit — "at most 25 files" for too many files, or "keep each batch under
  80MB — split the upload" for an oversize batch — and a configuration import that
  carries oversized form fields is no longer misreported as an oversized bundle
  file. Operators should also set a request-body size limit at their reverse proxy
  (for example Caddy `request_body { max_size }`) as the guaranteed backstop — see
  `docs/SECURITY-ATTACK-SURFACE.md`.

## 0.13.2 - 2026-07-23

- **Configuration transfer now covers three more club-wide settings, and guards
  against any future settings singleton being silently left out (#2200).** A
  bundle now carries your **login/security policy** (password-complexity rules
  and the magic-link link lifetime), your **public-content visibility** choices
  (the double-opt-in embed toggles and whether the public "Book Now" button
  shows), and your **subscription-billing policy** (invoice due-days and the
  family-billing model) — portable club decisions that previously stayed behind
  when you moved config between installs. Instance-specific settings deliberately
  do **not** travel and are now recorded as such with a reason: the Xero
  member-grouping mode (tied to your connected Xero organisation), per-lodge
  capacity/soft-cap settings (they belong with each lodge), setup-wizard
  progress, and the AI monthly spend cap. A new test enumerates every
  single-row (`id = "default"`) settings table straight from the schema and
  fails the build if one is neither exported nor explicitly excluded, so a future
  settings table can't quietly join the blind spot. Your **age-tier definitions**
  (the age bounds, labels, and per-tier subscription/family-request rules) now
  travel too, as a multi-row table: on import each tier is matched to the
  destination's existing tier and updated in place, so member pricing and
  classification stay intact; a bundle that would leave an incomplete or
  overlapping age partition is refused with a clear message pointing you to the
  Age Tiers admin page. No secret or credential travels. Note that this
  same release moves configuration bundles to format version 2 (#2187), so a
  bundle import across the version boundary is refused in either direction
  rather than applied partially.
- **The public website now paints from the same generated palette as the admin
  app (#2217).** The public site's neutral chrome — page, cards, borders, inputs,
  muted text, hover surfaces and the dark-nav hairline — is now resolved from the
  generated 12-step palette instead of ad-hoc colour-mixing recipes, so a club's
  saved colours drive every website surface the same way they drive the app. The
  branded look is unchanged by design: a light page, a gold primary action and
  focus ring, and a dark charcoal navigation bar are all preserved.
- **Status and label chips now draw from one generated colour system, and the
  last legacy accent colours are gone (#2218).** A sixth categorical colour (a
  teal, added to the generated palette) gives the booking board a distinct tone
  for the "waitlist offered" state, which lets the older hand-tuned accent
  colours behind the payments, member, audit, bed-type and family-group chips
  retire entirely — every coloured chip now follows the club theme through the
  same generated scales, so colours stay consistent and readable in light and
  dark by construction. No workflow changes; a few admin chips shift hue slightly.
- **Theme burn-down: the last hand-picked colours leave the product, and the
  four dead theme columns are dropped from the database (#2190).** This closes
  out the theme rebuild. The finance dashboard's mix/breakdown charts now draw
  their series colours from the generated categorical scales instead of a fixed
  hand-picked list (the old palette led with a bright gold that belonged to one
  fork), so the chart colours are part of the same generated system as the rest
  of the app. Five small admin surfaces that were still painted with raw colour
  utilities — the booking-calendar draft and waitlist-offered swatches, the Xero
  activity status chips, and the member-import step marker — now use theme
  tokens, so they follow the club palette and the light/dark toggle. The one
  fork-specific brand colour that lingered in shared code (a gold accent and its
  reference values) is removed from the shipping product; a fork's own colours
  live only in that deployment's saved theme. Finally, the four legacy theme
  columns that stopped being used when Site Style moved to three seeds
  (`brandCharcoal` / `brandRidge` / `brandMist` / `brandSnow`) are **dropped from
  the `ClubTheme` table** by a contract migration — the surfaces they used to
  hold are derived from the generated palette at render time, so nothing is lost
  and the change is invisible to operators. **Operators: this migration removes
  database columns and must run only after the previous release (the three-seed
  substrate, #2187) has been deployed and drained; the blue/green safety ledger
  records the sequence.**
- **The Integrations hub stays reachable when Xero is off (#2216).** The
  `/admin/integrations` hub was gated behind the `xeroIntegration` module, so
  turning Xero off made the whole hub — and any page that links back to it (the
  AI assistant, Stripe, Google sign-in, and Backups setup pages) — return a 404,
  hiding every non-Xero integration. The hub is no longer module-gated: it
  renders whenever any integration is available and shows each card only when
  that integration's own module and permissions allow, so the Xero card still
  disappears with Xero off while everything else stays reachable. No behaviour
  changes for the individual setup pages, which keep their existing gates.
- **Docs: ratified that connected provider credentials (`IntegrationCredential`) are permanently excluded from config transfer — never travelling in any form, and no presence-metadata carve-out — in the config-transfer reference and the security attack-surface doc (owner decision, #2205).**
- **The lodge kiosk / wall display now paints from a fixed, glare-proof colour
  set that never follows the club theme or the light/dark toggle (#2189).** The
  kiosk, its roster-setup wizard, and the lodge-instructions panel were the one
  place still authored in hard-coded slate/colour classes with a special
  light-mode readability patch. They now render from a dedicated fixed `--kiosk-*`
  token set — a near-black background, neutral grey surfaces, one fixed action
  accent, and legible status colours — generated once from the pinned kiosk seed
  and identical on every club in either theme, so a wall-mounted screen always
  looks the same and stays easy to read at a distance. Nothing else changes for
  operators; the migration also lets the repo-wide "no raw colour classes" source
  checks cover the kiosk tree with no remaining exceptions. The separate `display`
  route already used its own CSS-variable colours and is unchanged.
- **Site Style now derives the whole theme from three seed colours instead of
  seven hand-picked ones (#2187).** You pick one required accent (your club's
  brand colour) plus, optionally, a neutral character and a support accent; a
  vendored Radix colour generator turns those seeds into the full light/dark
  palette, with cross-colour text contrast guaranteed by construction. Because
  contrast is now guaranteed, a low-contrast pick is no longer rejected — the
  wizard **saves it and discloses the colours it adjusted** (before → after)
  rather than blocking you. Colour input is hex only. Configuration bundles move
  to **format version 2**; a bundle exported by an older app (version 1) is
  refused with a clear message rather than importing stale colour columns. The
  whole member and admin app now paints from the generated palette (the admin
  sidebar reads as a light surface, hover states on quiet buttons are visible
  again, and the member-facing booking/profile/public pages follow your theme),
  so this release is a **single visible restyle** — component names are
  unchanged, only the colours behind them (#2187, #2188).
- **Connecting Xero, Stripe, and Google sign-in is now a guided in-app wizard
  instead of an environment-variable chore (#2080, #2081, #2082, #2087).**
  Building on the encrypted credential store from v0.13.1 (#2079), each provider
  now has a step-by-step setup wizard at **Admin → Integrations** that walks a
  Full Admin through creating the app on the provider's side, pasting the
  credentials straight into the encrypted vault, and confirming the connection
  works before anything goes live — no `.env` editing and no redeploy. **Xero**
  (#2080/#2081) leads you through app creation, credential capture, and the OAuth
  connect on a reusable wizard shell, then completes the setup with verified
  webhooks, item-code mappings, and member import, and shows an amber badge on
  the setup page when webhook verification still needs attention. **Stripe**
  (#2082) captures its keys the same way and reads the publishable key at runtime
  from the store, so changing keys takes effect immediately rather than needing a
  fresh build. **Google sign-in** (#2087) captures its OAuth credentials in-app,
  runs on a request-scoped NextAuth config, and keeps the module locked until a
  real Google round-trip verifies, so an unconfigured provider can never render a
  visibly broken sign-in path. Legacy provider env vars are detected, warned
  about, and ignored — re-enter the values in the wizard, then remove the env
  vars.
- **Database backups are now configured in the app, not the environment
  (#2095).** Backup settings — the S3 access key and secret, destination bucket
  and region, retention window, the restore-validation shadow database, and the
  on/off switch — move into the same encrypted credential store as the other
  providers and are managed from a new **Admin → Integrations → Database Backups**
  page (`/admin/backups`), with a **Run backup now** action that runs as a
  background job behind a database-level cross-process lock so two containers can
  never run it at once. The S3 secret and the restore-validation connection
  string are write-only and never echoed back. **Operators: the legacy `BACKUP_*`
  environment variables are no longer read.** An install that configured backups
  through the old env vars upgrades to an empty store, so **until you re-enter the
  backup settings on the new page the nightly backup reports a loud FAILURE
  rather than silently skipping** — a stopped disaster-recovery path must alert,
  not disappear. Only `BACKUP_CRON_SCHEDULE` (when the nightly job fires) stays in
  the environment.
- **A new opt-in AI help assistant answers members' free-text questions, and the
  in-app help is now a chat-style widget on every surface (#2094).** The help
  system was rebuilt (#2209, #2210): a single curated help corpus feeds a
  chat-style help widget that appears on every member and admin page, answering
  page-specific questions and showing a full page guide, replacing the older
  scattered help UIs. On top of that, an **optional AI help assistant** module
  (#2211, #2212) — **off by default** — lets authenticated members ask free-text
  questions that a paid AI model (Anthropic Claude Haiku 4.5) answers **grounded
  strictly in that curated corpus**. The club supplies its own Anthropic API key,
  entered in-app and held only in the encrypted vault (never an environment
  variable), and a **hard monthly spend cap** (default **NZ$10**, stored in
  integer cents) stops AI answers for the rest of the month once reached; the
  budget gate **fails closed**, reserving a conservative worst-case cost before
  each call so the cap trips early rather than late, and stops spending entirely
  if it can no longer record usage. Enabling the module without a key is harmless —
  the ask box degrades to a structured fallback and the curated page help still
  works. Members are told the answer may be wrong and that their question is sent
  to Anthropic (United States); the question text itself is never stored.
- **Configuration transfer now fails the build if a club-settings column is
  neither exported nor explicitly excluded (#2178).** A reverse-drift guard
  audits the club-settings tables against what the config bundle actually carries,
  so a newly added settings column can no longer quietly fall out of a transfer —
  it must be either exported or listed with a reason for staying behind. This
  complements the singleton-table audit (#2200) and changes nothing an operator
  sees; it protects future config transfers from silently losing a setting.
- **Season-subscription charge-coverage reconciliation now reads active coverage
  correctly (#2179).** The guard that flips a stale, untouched
  `NOT_REQUIRED` seed subscription row to `NOT_INVOICED` was testing a
  to-many coverage relation with a null-check that was always true, so it never
  actually fired against real data. It now checks for an **active** charge-coverage
  claim (an unreleased one — a claim whose invoice was voided no longer blocks a
  re-billable member) both when it reads and, relationally, when it writes, so the
  reconcile correctly stands aside when live coverage exists and proceeds when it
  does not. No visible workflow change; billing status stays accurate for members
  whose coverage was released.
- **Dependency security advisories cleared (#2196, #2224).** Routine dependency
  patching resolved newly published advisories in `hono`, `fast-uri`, `dompurify`,
  and `sharp` (#2196) and moved Next.js to 16.2.11 to clear a middleware-bypass
  and a Server-Actions denial-of-service advisory (#2224). No behaviour change.

## 0.13.1 - 2026-07-22

- **Provider credentials now live in an encrypted database store, and Xero
  resolves from it only — env `XERO_*` is no longer read at runtime (#2079).**
  A new `IntegrationCredential` table (additive migration
  `20260721210000_add_integration_credential`) holds AES-256-GCM ciphertext under
  a key derived by real HKDF-SHA256 from the canonical `getAuthSecret()` resolver
  (a fixed documented salt and versioned info labels), with a fresh random IV per
  encrypt and GCM AAD (`provider:key:labelVersion`) binding every ciphertext to
  its row. A `secretSource` field records which env name the auth secret resolved
  from, so a silent `AUTH_SECRET`↔`NEXTAUTH_SECRET` flip is **diagnosable** (it
  still decrypts, and is flagged); a changed secret *value* fails cleanly into a
  "needs re-entry" state, never a crash. **This is a hard cutover of Xero
  credential resolution:** `getOperationalXeroConfig()`,
  `getOperationalXeroEncryptionKey()`, and the new
  `getOperationalXeroWebhookKey()` resolve from the store, and env
  `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REDIRECT_URI` /
  `XERO_ENCRYPTION_KEY` / `XERO_WEBHOOK_KEY` are **no longer read for operation** —
  legacy values are **detected and flagged** in setup readiness ("configured
  in-app now — re-enter there, then remove these"), never silently honoured and
  never silently ignored. The webhook route resolves its HMAC key through the
  shared resolver and stays **fail-closed** (a missing or unreadable key rejects
  every delivery), and the OAuth redirect URI now derives from `NEXTAUTH_URL`
  (`{origin}/api/admin/xero/callback`) instead of the old `localhost:3000`
  fallback.

  A cross-process credential cache (45 s TTL, invalidated in-process on write,
  never caching a negative or a DB error beyond the TTL) lets the cron-leader
  container observe a web-slot credential write within the TTL without a restart.
  An **AUTH_SECRET strength gate** hard-blocks credential capture when the secret
  is weak (< 32 chars, or a placeholder — a blocklist that catches the 41-char
  `.env.example` literal a naive length check would pass), shows a passive amber
  readiness warning from day one, and imposes **no boot-time enforcement**
  anywhere (token-key auto-generation simply no-ops, never throws, while gated).
  Writes go through a **write-only, Full-Admin-only** API
  (`/api/admin/integrations/credentials`): values are never returned, audit rows
  are metadata-only, and a metadata-only status GET keeps area admins' visibility.
  **Verify-reset:** writing client credentials drops the stored OAuth tokens
  (forcing a clean re-connect), while writing a webhook key re-arms webhook
  verification without dropping tokens. An interim **Xero Credentials** entry
  section on `/admin/xero/setup` makes the upgrade runbook followable now (the
  guided setup wizard supersedes it in a later release).

  For an existing env-configured install the previously stored Xero OAuth tokens
  were wrapped under the dropped `XERO_ENCRYPTION_KEY`, so they become
  **unreadable by design** (no silent key import): a typed `XeroTokenDecryptError`
  is mapped to the **reconnect** state, and the admin status panel, setup
  readiness, and the finance-report messaging all show "reconnect Xero" instead of
  a false "Connected". Nothing crashes at boot, cron, webhook, or page load — Xero
  sync, webhook verification, and invoice work are **fail-flagged and paused**
  until a Full Admin re-enters credentials and reconnects. The credential entity is
  **excluded from configuration export** (with `ciphertext`/`authTag` also in the
  forbidden-field patterns as defence in depth), the blue/green deploy script no
  longer hard-requires the dropped `XERO_*` vars (warn-only legacy sweep),
  docker-compose no longer plumbs them, and `.env.example` /
  `.env.staging.example` were rewritten. **Operator action is mandatory on
  upgrade** — see `DEPLOYMENT.md` → "Provider credentials: DB-only upgrade" and
  `docs/UPGRADING.md`. Trust now concentrates in the auth secret: a database
  backup plus the auth secret decrypts every stored credential, so production and
  clones must **never** share a secret (a restored clone is *expected* to enter
  re-entry) — see `docs/SECURITY-ATTACK-SURFACE.md` → "Credentials at rest".

### Release B (contract drops)

> **⚠️ Precondition (now satisfied): Release A must be the deployed, drained
> colour before this ships.** Release A shipped as **v0.13.0** and has been the
> deployed, drained production colour since 2026-07-22 NZT. These migrations
> drop a table and three columns that the **v0.12.2** colour still named in its
> SQL — shipping them against a draining v0.12.2 (verified) causes anonymous
> public **500s on every page carrying `{{hut-fees}}`** (`42P01 relation
> "SeasonRate" does not exist`); admin seasons pages 500; Xero item-code saves
> 500 (`42703 column "isMember" does not exist`); and age-tier saves plus the
> boot-time config self-heal failing on **every blue container start** — none
> of it recoverable by rolling the app back. The v0.13.0 colour names none of
> them, which is what makes this drop legal now. Cut as its own tag; the deploy
> still requires `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` with a
> `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` recording the v0.13.0 soak. See
> `docs/UPGRADING.md` → Unreleased.

- **Legacy contraction, Release B: `SeasonRate` and the doomed Xero columns are
  dropped (#2129 step 2, #2130 STEP 2).** Two destructive contract migrations
  finish the expand/migrate/contract series that E4 (#1930) and E8 (#1934)
  began. `20260721120000_contract_drop_season_rate` drops the frozen
  member/non-member boolean-keyed `SeasonRate` table; the same PR removes its
  last references, which were seed-only and outside `src/` (the
  `include: { rates: true }` read and the `rates: { create: … }` write in
  `e2e/setup/seed-second-lodge.ts`, and `createMissingSeasonRates` plus its two
  call sites in `prisma/seed.ts`). Nightly pricing, Xero hut-fee item codes and
  the public `{{hut-fees}}` embed have all read `MembershipTypeSeasonRate` since
  #2129 step 1, so nothing user-visible changes. Because the E4 fan-out that
  copied those rows forward was **conditional** on the install having a
  `MEMBER_RATE`-behaviour membership type and a `NON_MEMBER`-keyed type, the
  migration opens with a **pre-drop coverage guard**: it counts `SeasonRate`
  rows with no `MembershipTypeSeasonRate` counterpart for the same season and
  age tier and raises, aborting the transaction before the `DROP TABLE`, if any
  exist. A fork whose types never matched keeps its only copy of that pricing
  instead of losing it. `docs/UPGRADING.md` publishes the same check as a
  read-only operator pre-flight query; if it fires, reconcile the missing rates
  rather than forcing past it.

  `20260721130000_contract_drop_ismember_and_agetier_xero_columns` deletes the
  orphaned legacy `HUT_FEE` item-code rows that carried no `membershipTypeId`
  (not resolvable for pricing by the current runtime — both the resolver and the
  admin editor require the key; the only paths that still touch them count or
  collect item codes in aggregate and name no dropped column), then drops
  `XeroItemCodeMapping.isMember` with its old
  `(category, ageTier, seasonType, isMember)` unique, and drops
  `AgeTierSetting.xeroContactGroupId`/`xeroContactGroupName` (their data moved
  into `XeroContactGroupRule` at E8). The still-live partial index
  `XeroItemCodeMapping_hutfee_flat_unique` is untouched.

  **These migrations are legal only on top of the preceding runtime-prep
  releases and must not be deployed until those have shipped to production and
  soaked** — #2129 step 1 for `SeasonRate`, and #2133 (STEP 1, shipped in
  `v0.12.2`) plus the #2130 STEP 1.5 write-narrowing release for the columns.
  Dropping a column while an old colour still names it in a `SELECT` or an
  implicit `RETURNING` is exactly the blue/green break the multi-step exists to
  prevent. Deploying requires `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a
  `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` recording that soak; both migrations
  carry full rationale rows in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`. Operator
  actions: `docs/UPGRADING.md` → Unreleased. The `#2130` select guard
  (`doomed-column-select-guard.test.ts`) is **kept** even though its original
  columns are gone — narrow selects remain the rule for both models and it is
  the only repo-wide enforcement of it.

- **Connecting Stripe no longer involves `.env` files or a rebuild (#2082 —
  guided-setup epic #2078).** The Stripe secret key, publishable key, and webhook
  signing secret now live in the database, encrypted at rest under a key derived
  from the app's auth secret — the `STRIPE_SECRET_KEY`,
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` environment
  variables are **no longer read** (lingering values are detected and flagged for
  removal, never silently used). A step-by-step wizard on **Admin → Integrations
  → Stripe** walks a Full Admin from the Stripe dashboard keys through a write-only
  capture, a **Verify connection** step that reads the Stripe account and shows its
  name (the right-account confirmation), and an optional, freshness-scoped webhook
  step (endpoint URL to paste, signing secret back, verified via a Stripe test
  event). The **publishable key is delivered to the card form at runtime** from the
  store, so there is no build-time inlining and key changes take effect without a
  rebuild; the webhook route is **fail-closed** (no stored signing secret ⇒ every
  event rejected), and replacing any Stripe credential clears the verified webhook
  badge. **Upgrading an env-configured club:** card payments pause until the keys
  are re-entered in-app — the deployment guide carries the exact upgrade runbook,
  and the blue/green deploy script no longer requires the removed variables.
- **Connecting Xero no longer involves `.env` files, terminals, or restarts
  (#2079, #2080 — guided-setup epic #2078).** Xero credentials (client id,
  client secret, webhook key) now live in the database, encrypted at rest
  under a key derived from the app's auth secret — the `XERO_CLIENT_ID`,
  `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_ENCRYPTION_KEY`, and
  `XERO_WEBHOOK_KEY` environment variables are **no longer read** (lingering
  values are detected and flagged for removal, never silently used). A
  step-by-step wizard on **Admin → Xero → Setup** walks a Full Admin from
  "module switched on" to "connected to the right Xero organisation": exact
  copy-paste values for the Xero developer portal (including the real OAuth
  redirect URL, now derived from the deployment's own address), a write-only
  credential form guarded by an auth-secret strength check, and an OAuth
  connect step that confirms the connected organisation by name. Progress
  survives page reloads, and every step gates on verified success. **Upgrading
  an already-connected club:** previously stored Xero tokens become unreadable
  by design (the old env-var encryption key is retired), so Xero shows a clean
  "reconnect" state until credentials are re-entered in-app — the deployment
  guide carries the exact upgrade and auth-secret-rotation runbooks, and the
  blue/green deploy script no longer requires the removed variables.
- **The guided Xero setup now finishes the whole job: verified webhooks,
  account mapping, one-time import, and a summary (#2081 — epic #2078).** After
  connecting, the wizard adds an optional **Webhooks** step: it shows the exact
  delivery URL to paste into Xero, captures Xero's webhook signing key (Full
  Admin only, encrypted at rest), and **Verify** waits for Xero's real
  intent-to-receive validation ping to arrive on `/api/webhooks/xero` and pass
  HMAC before going green — so a green tick provably means the live round-trip
  works. Verification is freshness-scoped and key-bound: only a validation
  recorded *after* you press Verify and *matching the currently stored key*
  counts, so replacing the key re-arms verification. Webhooks stay **skippable**
  (a club can invoice from day one); skipping leaves a persistent amber
  **"Webhooks not configured — payment updates rely on scheduled sync"** badge
  on the Xero Setup and Xero Sync pages that a later verify clears everywhere,
  and a localhost/non-public-HTTPS deployment explains why webhooks can't verify
  there and defaults to Skip. The wizard then embeds the existing account/item
  mapping and one-time contact-import tools as steps and ends on a finish
  summary linking to day-to-day **Admin → Xero**.
- **The admin area now follows the club's saved site colours in light mode
  (#2144).** Every admin screen previously carried hard-coded light-grey
  ("slate") Tailwind colours that ignored the club theme in light mode; a
  sweep of 1,410 class occurrences across the admin tree moved them
  onto the same semantic theme tokens the finance dashboard has used since
  #2137, so a club with a strongly non-default palette now sees it applied
  consistently across admin. **Dark mode is visually unchanged for ~98% of
  occurrences, via two distinct mechanisms:** 1,277 conversions (90.6%) land
  on exactly the token the existing `.dark` neutral remap in `globals.css`
  already assigned to the old class, so for those the conversion is a
  provable dark-mode no-op; a further 103 (7.3%) — former
  `bg-{neutral}-50`-tier fills the remap sent to `--card` but the sweep
  classified as insets (`bg-muted`, 100) or selection states (`bg-accent`,
  3) — land on a DIFFERENT token that renders identically today only because
  `--card`, `--muted`, and `--accent` all resolve to `--brand-charcoal`
  inside `.dark .app-theme-scope`. The remaining 30 occurrences (~2%)
  genuinely change dark rendering: 26 are small deliberate dark-mode fixes on
  admin surfaces the remap never covered (seven unremapped
  `hover:bg-slate-200` fills, five unremapped `hover:` borders and text, a
  `border-white`, a `focus:ring-slate-400`, the arbitrary-variant
  table/code/quote fills in the page-content prose recipes, and the
  inversion of a light-on-dark CSS snippet), and 4 sit on the public
  hut-leader instructions page (next). **Two published member-facing surfaces
  moved too**, because they share the admin prose-styling recipe: the
  authenticated lodge-instructions page (inside `app-theme-scope`, where the
  three arbitrary-variant table-band and border conversions are small
  dark-mode fixes the remap never reached), and the public hut-leader
  instructions page — which renders under `website-theme`, NOT
  `app-theme-scope`, so its four converted occurrences resolve through the
  website palette and its instruction-table bands, borders, and body ink
  change subtly in BOTH modes. Two deliberate visual changes in light mode:
  (1) all five grey text
  tints collapse onto the single AA-clamped `text-muted-foreground` tone, so
  the faintest icon/label tints get slightly **darker** — a flattening of the
  old grey hierarchy accepted as an accessibility improvement; (2) recessed
  panels (nested strips, zebra rows, table header bands, read-only field
  fills) use the tinted `bg-muted` while cards and outer panels use
  `bg-card`, following the finance precedent, so insets stay visibly recessed
  under themes where the card and page colours coincide. One recorded
  hover regression, kept by owner decision: seven converted toolbar/refresh
  buttons (`bg-muted hover:bg-accent`) currently show no visible hover step
  because `--muted` and `--accent` share a value in app scope — the
  structural token split is #2181's scope, so these sites are deliberately
  not bandaided here. Deliberate
  exclusions keep their literal colours: the roster and induction print pages
  (paper output), the reports page's print-only borders, the display
  builder/preview signage letterboxes, the site-style code-preview panes,
  solid-fill status chips and swatches, and the member-import wizard's solid
  near-black active-step emphasis border. A widened source-contract test now
  gates the whole admin tree (plus finance) against raw neutral classes so
  they cannot creep back, with a nine-entry per-file allowlist covering
  exactly those exclusions.

- **Settings your club never saved now travel in a configuration export
  (#2171).** Every club-wide setting has a value even if nobody has ever opened
  and saved it — the built-in default the software runs on. Until now the export
  simply left such a setting out of the bundle, so importing it into another club
  quietly kept that club's own values instead of moving the source club's
  across, and a transfer could report success while the two clubs still behaved
  differently. The export now writes the built-in defaults in place of a setting
  that was never saved, for every club-wide settings record in the bundle —
  booking defaults, group discount, booking requests, modules, member fields, bed
  allocation, internet banking, membership nomination/lockout/cancellation. (A
  handful of individual columns are still deliberately outside the transfer
  allowlist and so do not travel; auditing those in both directions is tracked
  as #2178.)

  **Three things to know after importing such a bundle.** The settings record is
  created on the target club even though nobody configured it, so **Admin →
  Setup** will start counting booking defaults, group discount, membership
  cancellation, and module controls as configured or checked — the values are
  the same defaults it was already using, but the "has this been reviewed?"
  signal changes, so review those four steps after an import. On **Booking
  Policies**, the group-discount card's **Save** is now greyed out until you
  change something, where before an unsaved record left it enabled so you could
  create the record. And because the value is now written down rather than
  worked out fresh each time, a later release that changes a built-in default no
  longer reaches that club.

  **Club identity and email message settings behave differently, on purpose.**
  Every field there — club name, short name, hut-leader label, support and
  contact addresses, public URL — is an optional override on top of the
  install's own configuration file. When the source club has set them they
  export and import like any other setting, so a transfer does move the source's
  identity across, which is the intended behaviour. It is only when the source
  club has never set any override that "never saved" travels as "no override
  set" rather than as the source install's own fallback identity — and in that
  case importing leaves the target's identity alone entirely, creating no
  identity record where there was none, so the install's own boot-time identity
  repair keeps working.

  No schema, permission, or audit change, and no bundle format change: a bundle
  exported before this release still imports, leaving any setting it omits
  untouched. The built-in defaults themselves are unchanged — they simply moved
  to one shared place (`src/config/club-settings-defaults.ts`) so the export and
  the settings screens can never disagree about them.

## 0.13.0 - 2026-07-21

- **Annual-subscription billing no longer double-bills, and a voided invoice can
  be cleanly re-billed (#2147).** In production shapes where a season's charge and
  coverage rows were empty but the `MemberSubscription` rows were present — the
  exact configuration that triggered the incident — the billing preview and the
  in-transaction confirm could raise a second annual membership charge for a
  member Xero had already invoiced. The skip-set now treats a season
  `MemberSubscription` as already billed when its `status` is `PAID` **or** it
  carries a non-null `xeroInvoiceId`, and coverage-based dedup counts only
  **active** (unreleased) claims. A member who was manually marked paid with no
  invoice stays skipped exactly as before — the new invoice test is additive, not
  a replacement. For `PER_FAMILY` billing a family group is suppressed when any
  member holds a live season invoice or an active coverage claim, so a family
  bills once. When the Xero sync sees a charge's invoice **voided or deleted** it
  now atomically releases the coverage claim (`releasedAt` set, the row kept for
  audit), marks the charge `VOIDED` (kept for audit), bumps
  `MemberSubscription.voidGeneration`, and clears the subscription's invoice link
  back to `NOT_INVOICED`, so the member becomes re-billable; a post-void confirm
  derives a **new** idempotency key that folds in `voidGeneration`, and that key
  stays byte-identical for any subscription that was never voided. `VOIDED`
  charges are fenced out of every re-issue path — enqueue/RETRY_CHARGE, invoice
  creation, the outbox failure handler, and the admin panel (no Retry button) — so
  a retained voided row cannot cause a second Xero write. A collapsed-by-default
  "Already invoiced" section on the subscriptions billing preview now lists the
  count and each suppressed member's Xero invoice number and status. **One
  deliberate semantics change:** a voided invoice previously read as `UNPAID` (a
  booking lockout) and now reads as `NOT_INVOICED` (re-billable). Money stays in
  integer cents and no amount changes; this only affects which subscriptions are
  billed and when. The migration
  `20260720130000_subscription_invoice_dedup_void_release` is an additive
  expand — a new `VOIDED` enum value, a `voidGeneration` integer defaulting to 0,
  a nullable coverage `releasedAt`, and a swap of the coverage `subscriptionId`
  full UNIQUE for a partial UNIQUE over active claims — and is old-colour
  compatible; see `docs/UPGRADING.md`, `docs/guides/subscriptions.md`, and
  `docs/STATE_MACHINES.md`.

- **Deliberately fee-less age tiers no longer generate billing-exception noise,
  and stale exceptions clear on refresh — with provenance recorded (#2148).**
  Clubs that leave CHILD or INFANT tiers without a fee schedule were seeing dozens
  of `MISSING_FEE_SCHEDULE` exceptions (38 in the reported case) for members who
  are simply not billable. The preview's age-tier exemption gate now runs
  **before** the `MISSING_FEE_SCHEDULE` raise and no longer needs a resolved fee:
  a `BASED_ON_AGE_TIER` member whose season-start tier is not subscription-liable
  is treated as exempt when there is no fee for the tier or the resolved fee is
  `PER_MEMBER`, and those members join a new collapsed "Exempt" section instead of
  raising an exception — confirm still writes their `NOT_REQUIRED` season rows, as
  it always did. A tier-exempt child under a resolved `PER_FAMILY` fee still falls
  through to family billing, so families with exempt children keep billing exactly
  once. Separately, a new `finance:edit`-gated **Refresh preview** action rebuilds
  the preview under the same per-season advisory lock as confirm and auto-resolves
  every open `MembershipBillingException` the fresh preview no longer regenerates,
  while an exception that still reproduces is protected by an identity-based
  fingerprint and is never falsely resolved. To tell those two resolution paths
  apart, a new nullable `MembershipBillingException.resolvedVia` column (enum
  `CONFIRM | PREVIEW_RECONCILE`) records how each exception reached `RESOLVED`;
  existing and legacy resolved rows and every open row stay `NULL`, the documented
  "resolved before this column existed / not yet resolved" state. **What did not
  change:** no money moves, exceptions are never deleted (resolution only sets
  `resolvedAt` plus provenance), and the `finance:view` GET is now a verified pure
  read, so a view-only admin loading the page writes nothing. The migration
  `20260720140000_billing_exception_resolution_provenance` is a metadata-only
  expand (new enum, one nullable column, no backfill).

- **Whether a member owes an annual subscription is now decided by their
  membership type, not their admin role (#2149).** The old rule silently exempted
  anyone holding `role=ADMIN` or `role=LODGE` from the annual membership fee. That
  is removed from every derivation: a member's membership type
  (`subscriptionBehavior`, plus age tier where the type is `BASED_ON_AGE_TIER`) is
  now the sole authority on whether they owe a subscription, and the login `Role`
  enum goes back to being a pure permission concept. A fee-paying member who
  happens to hold an admin role now shows their **real** subscription status
  (Paid/Unpaid/Overdue) everywhere it is displayed. Five previously divergent
  copies of the derivation — the booking gate, the profile/subscription-status
  API, the admin members list and its SQL filter variants, the subscriptions list,
  the CSV export, and the Xero-sync status check — are consolidated onto two shared
  helpers, so the filter and the displayed flag can no longer disagree. To give the
  dropped exemption a database-backed fallback, the data-only migration
  `20260720180000_seed_admin_lodge_membership_types` seeds two built-in types —
  **ADMIN** (`subscriptionBehavior NOT_REQUIRED`, `bookingBehavior BLOCK_BOOKING`)
  and **LODGE** (`NOT_REQUIRED`, `MEMBER_RATE`) — and `defaultMembershipTypeKeyForRole`
  now maps ADMIN→ADMIN and LODGE→LODGE, where both previously fell through to the
  billable FULL type. The seed is idempotent and self-healing: it creates the two
  types if missing **and** reconciles the `isBuiltIn`/`isActive` and
  behaviour columns of any hand-created ADMIN/LODGE row, while **preserving an
  admin-edited name and description**. **The one behaviour change to watch:** a
  bare admin service account can no longer book as itself (its fallback type is
  `BLOCK_BOOKING`) — a real fee-paying human holding the admin permission is
  assigned a real membership type and is unaffected — and a LODGE kiosk account
  still books on behalf of members (`MEMBER_RATE`) and never owes a subscription.
  Permission checks are untouched, no rows are deleted, and the seed's timestamps
  use explicit UTC. See `docs/UPGRADING.md` and `docs/DOMAIN_INVARIANTS.md`.

- **Family fee suppression is now keyed to the invoice holder's own billing basis,
  with an operator "already invoiced" marker as the backstop (#2161, #2167).** A
  live legacy invoice sitting on one family member used to suppress the whole
  family's `PER_FAMILY` charge regardless of why that invoice existed. It now
  suppresses the family charge only when that holder's **own** resolved billing
  basis is `PER_FAMILY`; a `PER_MEMBER`-billed member's personal invoice no longer
  blocks the family fee (that member simply stays skipped per-member), and
  coverage-triggered suppression reads the basis directly from the covering charge
  row. The refinement is deliberately fail-closed: suppression lifts **only** on a
  proven `PER_MEMBER` holder basis — `PER_FAMILY`, no-invoice bases (Life/honorary
  via a fee row), and unresolvable bases all keep the family suppressed, and an
  unresolvable case carries an "Unresolved basis" badge in the audit panel — so
  the conservative never-double-bill guarantee is preserved for every shape the
  refinement did not explicitly open. To close the one ambiguous window that
  refinement re-opens (a family invoice on a member whose current basis is
  `PER_MEMBER`), a new `finance:edit`-gated **"already invoiced" marker** lets an
  operator suppress a family for a season regardless of basis: a new
  `FamilyGroupSeasonInvoiceMarker` table (migration
  `20260721100000_family_season_invoice_marker`, an additive expand), MARK/UNMARK
  actions on the existing billing route, an optional note and confirm step, a
  marker indicator with unmark in the "Already invoiced" section, and a partial
  unique index enforcing one active marker per `(familyGroupId, seasonYear)`. Both
  suppression sources live in the shared preview/confirm builder that confirm
  re-runs in-transaction under the per-season advisory lock, so preview and confirm
  agree. **What did not change:** money stays in integer cents and no amounts
  move — only which families are suppressed; markers are never deleted (unmark sets
  `releasedAt` and keeps the row for audit); and member merges repoint mark/release
  history to the surviving member.

- **Long bed names on the bed-allocation board are no longer clipped (#2150).**
  The allocation board's leftmost label column shared the 11rem width of the date
  columns, so typical bed names were cut off. The label column now has its own
  14rem width constant, bed names wrap to two lines with a `title` tooltip
  fallback for anything that still clips, and the room-name header gains the same
  tooltip fallback. The inline table-width formula and `colgroup` were updated to
  emit one label column plus one column per night. This is a pure display change
  on an existing admin-gated page: no data is read or written differently, and
  there is no schema, config, or permission change.

- **The two quote-timing cards now open with Edit, like everything else in
  Booking Policies (#2166).** On **Booking Policies → Public Booking Requests**,
  the **Quote Response Window & Reminders** and **School Attendee Confirmation**
  cards used to be typed into directly — no **Edit**, no **Cancel**, just a
  **Save** that lit up once a number changed. They were the last thing in the
  area that worked that way. Each now has its own **Edit** button that unlocks
  its boxes, its own **Save**, and its own **Cancel** that puts that card back
  the way it was saved without touching any other card. **This is a visible
  change for admins:** changing a quote window or an attendee prompt is now
  three clicks rather than two, deliberately, so the whole section behaves the
  same way and a stray keystroke in a settings box is no longer one click from a
  change. You can still have more than one card open at once; only saving is
  exclusive, because all three cards write the same settings record. Nothing
  else about them moved: the same ranges are enforced and the same explanation
  appears if a quote reminder is not shorter than its window. A read-only box is
  now shaded so you can see at a glance that it is waiting for **Edit**, rather
  than looking editable and ignoring your typing.

  **Saving is also safer against a second admin.** Each card still re-reads the
  stored settings immediately before it writes, and it now sends back only the
  boxes you actually changed. Previously, if someone else changed the quote
  window while your page was open and you edited only the reminder, your Save
  put the old window back. Now your untouched boxes are left exactly as they are
  stored, and after saving the card shows you the other admin's value. If that
  makes the two quote settings contradict each other — your new reminder is no
  longer shorter than a window someone else has shortened — nothing is written
  and you are told to reload and try again, instead of getting a bare
  "Invalid input".

  One thing worth knowing: a card you have not opened keeps showing the values
  it loaded with, even if another admin has since changed them, and clicking
  **Edit** does not refresh it — the same as everywhere else in the admin.
  Reload the page if you want to be certain. What that staleness can no longer
  do is get written back. No schema, permission, route, or audit change. See
  `docs/guides/booking-policies.md` and `docs/ARCHITECTURE.md`.
- **Most admin areas now explain view-only access once, at the top, instead of
  on each greyed-out button (#2160).** If your admin role can look at an area
  but not change it, you now meet a short banner at the top of the section when
  you arrive — "You have view-only access to this area", followed by what
  specifically you cannot change there and which permission would let you. The
  greyed-out buttons below it no longer each carry their own hidden copy of that
  explanation. The banner belongs to a section rather than to a page, so a
  screen built from several sections — Security, or Booking Requests — shows it
  once per section, three times in those two cases. This is the
  pattern Booking Policies adopted in #2142 (below), now applied across most of
  the admin tree: 210 of the 264 gated buttons are covered by a banner in their
  own section, and #2168 below takes the total to 231 — about seven out of eight
  now explained by a banner instead of individually. **Nothing about who can do what
  has changed** — the same
  people can edit the same things, every button is gated exactly as it was, and
  no write path, price, or permission moved.

  The reason for the change is that the old per-button explanation reached
  almost nobody. A greyed-out button is skipped by the keyboard, so it was
  attached to something most people never land on, and its hover tooltip never
  appeared at all because greyed-out buttons do not respond to the mouse. Saying
  it once, at the top, in the normal reading order, means a screen-reader user
  hears it on arrival and a sighted user simply reads it.

  **One honest limitation.** Greyed-out buttons are still skipped by the
  keyboard — the banner tells you why the area is read-only, but you still
  cannot tab onto a disabled button to ask it. Making those buttons focusable
  was considered and deliberately not done: it would turn every gated control
  into a clickable one that has to be individually stopped from saving, and the
  risk of getting that wrong on a money or membership screen outweighed the
  benefit.

  **What is not converted.** 32 controls still carry their own per-button
  explanation. They are places no banner can reach — inside a pop-up dialog or
  dropdown menu, or in small toolbars dropped into another page's layout — plus
  the member detail **Account credit** card, explained below. See
  `docs/ARCHITECTURE.md` and `docs/STYLE_GUIDE.md`.

- **The member detail page now explains view-only access once at the top, not
  nine times down the page (#2168).** A member's page is built from nine
  per-record cards (credit, lifecycle, committee, partner link, deletion,
  dependents, parent links, lodge access, seasonal membership). Giving each of
  them the #2160 banner would have repeated the same sentence three times in the
  Family section alone and nine times on the page, so the cards were held back
  from that rollout. The owner's decision was one banner for the whole page, and
  that is what now happens: a view-only admin arriving at a member sees the
  banner once, above everything, and the buttons below it no longer each carry
  their own hidden copy of the reason. Three cards that also repeated the
  sentence in their own smaller notice — committee assignments, lodge access,
  seasonal membership — now leave it to the page banner as well. **Nothing about
  who can do what has changed:** every button is gated exactly as it was.

  **One card is deliberately left out.** The **Account credit** card's buttons
  depend on *finance* permission, while the page banner speaks about
  *membership* permission. An admin who can edit membership but only view
  finance would get no banner at all, and vouching for that card would point
  everyone else at the wrong permission, so its four buttons keep their own
  explanation. A second banner just for finance would have put two banners back
  on the page, which is what the decision was about.

  Sibling banners on other screens — Security and Booking Requests still show
  three each — are **not** changed here; whether they should collapse the same
  way remains an open decision.

- **Cleared four new dependency security advisories that were failing CI.**
  `npm audit` began reporting one moderate and three high-severity advisories
  against two transitive packages, which turned the required `verify` job red on
  `main` and on every open pull request. Both packages are pinned by exact
  `overrides` entries in `package.json` — which is why `npm audit fix` reported
  a fix was available but changed nothing — so the pins were bumped instead:
  `axios` `1.16.1` → `1.18.1` and `brace-expansion` `5.0.6` → `5.0.7`. Nothing
  else in the lockfile moved. `npm audit` is now clean.
  - `axios` is reached only through the `xero-node` SDK, which requests
    `^1.7.7`; `1.18.1` satisfies that range, so **`xero-node` itself did not
    move** and stays on `18.0.0`. No application code changed.
  - The advisories cleared are the `formDataToJSON` and deep `formToJSON`
    recursion denial-of-service pair, prototype pollution via auth subfields and
    via request-construction gadgets, `maxBodyLength` bypasses on the fetch and
    HTTP/2 upload paths, a `NO_PROXY` bypass for local addresses, proxy
    inheritance after interceptor config cloning, a form-serializer `maxDepth`
    bypass, and the `brace-expansion` exponential-time expansion
    denial-of-service.
  - **Behaviour risk to the Xero money path is low but not nil.** The axios
    releases in between harden redirect, proxy, and URL handling: sensitive
    caller-supplied headers are now stripped on cross-origin redirects, Basic
    auth is retained on same-origin redirects but stripped cross-origin, and
    malformed `http:`/`https:` URLs without `//` are now rejected with
    `ERR_INVALID_URL`. The two new `transitional` flags both default to their
    backwards-compatible values (`advertiseZstdAcceptEncoding: false`, so
    `Accept-Encoding` on the wire is unchanged, and
    `validateStatusUndefinedResolves: true`, which leaves status handling as it
    was). `xero-node` sends invoice, payment, credit-note, and contact bodies as
    JSON with no `paramsSerializer`, `socketPath`, `maxBodyLength`, or FormData
    configuration, so the hardened form-serialization and body-limit paths are
    not on our call path at all.

- **"Show indicative pricing" no longer changes the public site the moment you
  click it (#2162).** On **Booking Policies → Public Booking Requests**, the
  **Show indicative pricing on the request form** checkbox used to save the
  instant it was ticked — one stray click and the public request form switched
  between "Request to Book" (with a price) and "Request for Price" (without
  one), with an audit entry to match. It now works like every other setting in
  the area: click **Edit** on the Indicative Pricing card, tick or untick the
  box, then **Save indicative pricing**, with **Cancel** to put it back. Save
  stays greyed out until you have actually changed something, so an
  open-and-close cannot record a change that never happened. **This is a visible
  change for admins:** a one-click toggle is now three clicks, deliberately, to
  match the rest of Booking Policies. Three related fixes ride along. All three
  cards in the section now re-read the stored settings immediately before they
  write, so saving any one of them will not quietly overwrite what another
  admin changed in another card while your page was open — or what you typed
  into a card below but have not saved yet. (Two admins who hit Save in the same
  instant still resolve last-one-wins, as they always have; what is fixed is the
  page that has been sitting open.) A **Save** never lights up on its own
  either: each card's boxes and the saved values they are compared against only
  ever move together, so no other card's save can arm yours, and anything you
  had typed is left exactly as you left it (#2166 finished this by giving each
  card its own draft). And the save now sends the school-attendee timings
  back to the browser as well as the pricing and quote ones; previously they
  came back missing, which blanked both attendee boxes after any save and then
  made the next quote-timing save fail outright. No schema, permission, or audit
  change. The only API change is additive and has one caller: the settings PUT
  now returns the two school-attendee fields it was already storing, alongside
  the three it already returned. If that re-read itself fails, the message now
  says your change was not saved, instead of reporting a settings-load failure
  for a save you had just clicked. See `docs/guides/booking-policies.md` and
  `docs/ARCHITECTURE.md`.

- **Markdown is pinned to LF line endings (#2162).** `.gitattributes` already
  pinned `prisma/schema.prisma` and `scripts/*.mjs` after a Windows editor
  silently rewrote the schema to CRLF and turned a 14-line change into a
  ~9,400-line conflict at the next port (#2129). The same thing then happened to
  `AGENTS.md` and `docs/ARCHITECTURE.md` — two of the most-ported files in the
  repo — turning a 28-line edit into an 848-line diff, destroying blame, and
  making `git diff --check` flag every line. `*.md text eol=lf` now covers the
  whole set; all 186 tracked markdown files were already LF, so nothing else
  moves. Developer tooling only, with no runtime effect.

- **Secondary text in the member and admin app now actually looks secondary
  (#2145).** Small labels, hints, and footnotes are meant to sit a step below
  normal text, but inside the themed app they rendered in exactly the same
  colour as normal text — the "muted" role was set to the same brand colour as
  the main text colour, so it did nothing. That role is now worked out from your
  saved brand neutrals as a genuinely softer tone, in both light and dark mode.
  **This is a visible change:** every muted label across the member, admin, and
  finance screens gets lighter. **Dark mode changes noticeably more than light
  mode**, and that is expected: about half the affected places reach this
  colour through the dark-only neutral remap that already rewrites literal
  `slate`/`gray` text onto the muted role, so in dark mode those labels move
  from full body strength to the new softer tone, while in light mode they are
  untouched. It is not a new colour picker — the tone is
  derived from the **Deep**, **Snow**, **Mist**, and **Charcoal** colours you
  already choose in **Site Style**. Before it ships, the derived tone is checked
  in both modes against each background secondary text actually appears on — the
  page and card background, the tinted-row background, and the four built-in
  notice panels (warning, information, success, danger) — and pulled back
  toward the main text colour if it would otherwise drop below the WCAG AA 4.5:1
  minimum on any of them. It is meant to be softer than normal text — that is
  what makes it read as secondary — but never softer than that minimum; and
  where your own main text colour already falls short on one of the notice
  panels, the secondary tone is held to no worse than it. Dividers and hairlines
  are deliberately outside that check: text
  is not meant to sit on a divider, and the one badge that did has been moved
  onto the tinted-row background instead. A
  palette whose neutrals sit very close together has no room to soften at all,
  and secondary text stays identical to normal text, exactly as it was before;
  that is the accessible outcome rather than a failure. Printing and PDF export
  are unaffected: the role keeps its light/dark pairing, so paper keeps the light
  tone (the #2146 guarantee below). No schema, API, or data change. See
  `docs/guides/site-style.md` and `docs/ARCHITECTURE.md`.

- **Printing or exporting a report in dark mode no longer produces a blank page
  (#2146).** A finance manager or admin browsing in dark mode who used **Download
  PDF**, or the browser print dialog, on `/finance` or `/admin/reports` got a
  page that looked empty: the print stylesheet forced a white background but the
  card text stayed on the dark theme's near-white colour. Print and PDF now always
  render the light colour scheme regardless of the theme you are browsing in, so
  no theme switch is needed before exporting. The same fix covers every other
  printable surface — the chore roster sheet, the induction sign-off sheet, and
  the lodge instructions. The public hut-leader instructions page was swept too
  and needed no change: it renders on the website theme, which never goes dark.
  Structurally, each rule that installs the dark palette is now excluded from
  print media rather than being fought with additional `!important` overrides,
  and the `html2canvas` PDF capture renders its clone in the light palette. No
  behaviour change on screen. A browser test now prints both report surfaces in
  dark mode and checks the ink really is dark on a light page. See
  `docs/guides/reports.md`, `docs/finance-dashboard/README.md`, and
  `docs/ARCHITECTURE.md`.

- **Config transfer: old-bundle entrance-fee/season-rate import compat dropped
  (#2131).** One release after the E13 contraction, the importer no longer
  accepts the legacy boolean-keyed bundle shapes: the `isMember` column on
  `season-rates.csv` and on the Xero `item-code-mappings.csv` HUT_FEE rows, and
  the pre-#1931 `ENTRANCE_FEE` item-code category name. A bundle carrying any of
  these is now **rejected at dry-run** with a clear, row-named validation error
  that disables Apply and points to re-exporting from an install running the
  current release (**v0.12.2 was the last release that could import the legacy
  shape**) — never a silent partial import. A bundle whose source install is
  gone can still be hand-converted: see "Converting a legacy bundle by hand" in
  `docs/guides/config-transfer.md`. Relatedly, a `HUT_FEE` item-code row with a
  **blank `membershipTypeKey`** is now a blocking row error rather than a
  silently-written keyless mapping the runtime never reads — this only affects
  hand-authored bundles, as the exporter always emits the key. New-bundle
  export/import is byte-identical, and the #1931 item-code-amount joining-fee
  materialisation (for current `JOINING_FEE` rows) is unchanged. No schema
  change. Operator actions: `docs/UPGRADING.md` → Unreleased. See
  `docs/config-transfer/README.md`.

- **Blue/green runtime-prep for the legacy Xero column drops, write half
  (#2130).** `v0.12.2` narrowed the two READ paths (`getHutFeeItemCodeMap`,
  `getAgeTierSettings`) with an explicit `select` so the deployed Prisma client
  stopped naming `XeroItemCodeMapping.isMember` and
  `AgeTierSetting.xeroContactGroupId`/`xeroContactGroupName`. That was
  incomplete: Prisma also emits an implicit `RETURNING` over **every** scalar
  column of a `create`/`update`/`upsert` unless a `select` narrows it, so the
  unnarrowed WRITE paths still named the doomed columns and a draining old
  colour would keep issuing that SQL. Every mutation on those two models is now
  narrowed — the admin item-code-mappings route, the admin age-tier-settings
  route, config-transfer's Xero import, the setup wizard, and the seed — each to
  the minimal projection its (discarded) result needs. Regression pins assert
  the `select` on each mutation, and a static source-scan guard (modelled on the
  existing `ClubModuleSettings` select guard) fails CI on any future call site
  on either model that forgets its `select` — across `src/`, `prisma/seed.ts`
  and `scripts/` — so the narrowing cannot silently regress before the drop.
  As defensive cleanup, the already-retired raw-SQL audit script
  `audit-access-role-membership-cleanup.ts` also stopped naming the age-tier
  Xero-group columns (its `managedAgeTierSettings` metric and paired "Managed
  Xero age-tier rules backfilled" check were removed). That script never
  executes — it returns early now that the `20260720120000` contraction
  migration exists — so no live audit coverage was lost and it was never part of
  the blue/green gap. **No schema change and no migration in this release**: it
  is runtime-prep only. Only **after this release has itself deployed** are
  `isMember` (with its old `@@unique`) and the two `xeroContactGroup*` columns
  drop-eligible, by a *later* release's contract migration — never the same
  release as this prep. That contract migration is
  `20260721130000_contract_drop_ismember_and_agetier_xero_columns` (STEP 2 — see
  the **Release B** section below, which must be its own, later version tag).

- **Public `{{hut-fees}}` embed now reads the authoritative per-membership-type
  rates (#2129, step 1).** The embed was the last reader of the frozen
  member/non-member `SeasonRate` table, and it presented a definition list of
  "Age tier — Member/Non-member" rows. It now reads
  `MembershipTypeSeasonRate` — the same rows that actually price a booking — and
  renders a **real table** per lodge × season: age tiers down the side,
  membership-type rate columns across the top. A membership type earns a column
  only when it is active, **publicly listed**, and carries rates for that
  season; types priced identically collapse into one shared column headed by
  their names (for example "Full Member, Life, Family"), and split back out
  automatically the moment one of them is repriced. Where a column is shared,
  the table says so in one line, so a multi-name heading does not read as a
  rendering glitch. Wide tables scroll inside their own container so the page
  never scrolls sideways; that scroller is keyboard-focusable and named, each
  table is named from its own heading, and a cell with no rate is announced as
  "No rate" rather than as a silent em dash.

  Token semantics changed with it: `type=` now genuinely **filters** to one
  membership type's column (it previously only validated that the key existed),
  `group-by=type` splits a season into one table per rate column (it previously
  split into Member and Non-member groups), and `group-by=age` **orients** the
  table so membership types are the rows and age tiers the columns (it
  previously did nothing). Note that `group-by=age` here *orients* one table,
  whereas `{{joining-fees}}`'s `by-age` *groups* into one block per tier — the
  two are deliberately different, and `docs/PUBLIC_PAGE_CONTENT_TOKENS.md` says
  why. Unknown lodge slugs and unknown or unlisted `type=` values still fail
  closed to the no-information state. The setup-readiness **Seasons And Rates**
  step now warns when the embed is switched on, its token is on a published
  page, and a season would publish fewer than two rate columns.

  Also fixed along the way: the lodge-setup **copy seasons** action had been
  posting the legacy `rates` key, which the season API stopped accepting at the
  E4 re-key, so every copy silently failed validation. It now posts
  `membershipTypeRates` and works again.

  No schema change in this step: `SeasonRate` was untouched, and the step
  removed its last **application-runtime** reader (the embed; the admin season
  routes and the lodge-setup copy flow also stopped selecting it). The only
  surviving references were seed-time and outside `src/` — the
  `include: { rates: true }` read and the `rates: { create: … }` write in
  `e2e/setup/seed-second-lodge.ts`, and `createMissingSeasonRates` in
  `prisma/seed.ts` — and step 2 (Release B, below) removed all three in the same
  PR as the DROP migration, which is what kept the build green: `e2e/**` sits
  inside `tsconfig.json`'s `**/*.ts` include and is not excluded, so leaving the
  seeder alone would have failed `npm run typecheck`; and
  `scripts/e2e-stack.sh:92` runs that seeder under `E2E_MULTI_LODGE=1`, so the
  required **E2E multi-lodge** branch-protection check fails at seed time.

- **Shared `useSectionEditState` hook for admin settings sections (#2136).**
  The canonical settings-section pattern (`AGENTS.md`) — load read-only,
  per-section Edit reveals Save/Cancel, nothing auto-persists on toggle, Cancel
  reverts to the saved snapshot, Save persists once — had every card
  re-deriving the same draft/snapshot bookkeeping by hand. `useSectionEditState`
  (`src/hooks/use-section-edit-state.ts`) now owns it, centralising the two
  details that are easiest to get subtly wrong: Cancel restores *every* field
  from the snapshot, and Save re-seeds both the draft and the snapshot from what
  the card's save callback returns rather than from the submitted draft — so a
  card that returns the parsed server response (the group discount and password
  policy cards) never leaves a clamped or normalised value misreported in the
  form. The guarantee is only as good as what that callback returns: the email
  sign-in link and Google sign-in cards return locally-computed values because
  neither route echoes the stored row back, which is safe only because those
  routes reject out-of-range input rather than clamping it. Adopted by the group
  discount, password policy, email sign-in link, and Google sign-in
  sections. Transport stays in each card's own save callback, so the security
  cards' GET-fresh-settings-then-merge step — which stops one card clobbering a
  module another card changed since page load — and their multi-endpoint saves
  are unchanged. Refactor only: no admin-visible behaviour change, and every
  existing card test passes unmodified. Also removes a redundant `!canEdit`
  wrapper around `AdminViewOnlyNotice` in three sections; the notice already
  gates on `canEdit === false` internally (#2065), a strictly stronger condition
  than the wrapper's, so the wrapper was a no-op in all three tri-states.

- **Theming follow-ups: categorical teal on tokens, and a themed /finance body
  (#2137).** Three related cleanups to the theme-token system. First, the
  categorical teal that was still written as literal Tailwind utilities now
  reaches its hue through the `--hue-*` tokens via `CHIP_TONE_CLASSES.teal`: the
  waitlist-offered booking chip, the audit-log `family` category badge, and the
  family-group `GROUP_CREATE` badge. Each of those was already written on the
  Tailwind -100/-800 pairing the `--hue-*` tokens encode, so the migration is
  value-identical — no visible change. The admin dashboard Chore Roster tile was
  deliberately left on `bg-teal-50`/`text-teal-600` and allowlisted instead: it
  uses the -50/-600 tile convention and is one of five identically-built
  quick-link tiles, so moving it alone would have made the row non-uniform.
  The audit category badge map was duplicated verbatim between the member
  timeline and the admin audit-log page and is now a single shared module
  (`src/lib/audit-category-badges.ts`), so the two surfaces can no longer drift.
  The brand-colour contract test's allowlist shrinks from six files to two: the
  admin booking calendar keeps `bg-teal-500`, because it is a solid status
  swatch with no muted-background / accent-text pairing and the `--hue-*` system
  is defined only as such a pair; the dashboard tile keeps its -50/-600 pair for
  the row-uniformity reason above. The calendar-colour regression pin in
  `phase1-bug-fixes.test.ts` previously asserted against a LOCAL FIXTURE COPY of
  the colour map, so it constrained nothing; it now imports the real exported
  map. Second, `FINANCE_MIX_COLORS` is confirmed as a deliberate KEEP — the
  literal hex palette stays, per the #1801 carve-out — and its doc comment is
  corrected: it had claimed chart neutrals were tokenised in `trend-chart.tsx`,
  when that file still passes literal strokes as SVG presentation attributes
  (where `var()` cannot resolve) and the real theming happens in `globals.css`
  via the `.finance-trend-chart .recharts-*` selectors. Third, the `/finance`
  dashboard was themed at the chrome level only, so its BODY rendered raw
  slate/white inside `app-theme-scope`. Dark mode was NOT broken by this — the
  existing `.dark .app-theme-scope` neutral remap in `globals.css` (#1263) had
  those utilities covered — but that shim is dark-only, so in LIGHT mode the
  body did not follow a strongly non-default club theme; the dashboard, ratio
  explorer, KPI cards,
  and pie-chart tooltip now use the semantic surface tokens (`bg-card`,
  `text-card-foreground`, `bg-popover`, `text-muted-foreground`, `bg-muted`,
  `border-border`), with no layout, spacing, or value-rendering changes. A new
  contract test keeps the finance tree free of raw neutral Tailwind utilities
  (the whole slate/gray/zinc/neutral/stone family, plus `bg-white` and
  `bg`/`text-black`, matching how the dark shim groups them); it is deliberately
  scoped to that tree rather than repo-wide, because the admin tree still
  carries raw slate in roughly 111 files and must be migrated before the check
  can be widened. Chart hex colours are unaffected — they remain the documented
  #1801 SVG-presentation-attribute carve-out.

- **Booking-policies Save buttons: unified view-only gating, and no more no-op
  group-discount saves (#2142, #2143).** Two carry-forwards from #2136. First,
  every Save/Create button across the five **Booking Policies** sections — group
  discount, booking periods, minimum night stay, default cancellation policy,
  and public booking requests — now goes through `ViewOnlyActionButton`, the same
  wrapper the security cards and these sections' own Edit buttons already used.
  The behaviour change is narrow but real: `useAdminAreaEditAccess` is tri-state
  and can narrow **after** the form was opened (a session refetch reducing the
  actor's permissions mid-edit), and in that window Save previously stayed
  clickable and the admin walked into a 403 mapped to the "not saved" notice.
  It now disables immediately. While access is still *resolving* (`undefined`)
  the button is disabled **neutrally**, with no reason shown, so an admin who
  turns out to be edit-capable never sees a "view only" message flash.
  No security consequence either way — Save only ever rendered behind the
  already-gated Edit, and each write route enforces `bookings:edit`
  independently. The two public-booking-request Saves were also raw `<button>`
  elements styled with brand utilities; they now use the shared themed `Button`
  like the other four sections, so they follow the club theme.

  **The explanation for a view-only disabled state now lives at the section
  level, not on each button.** A `disabled` button is out of the tab order, so
  the reason it used to carry was attached to an element a keyboard user never
  lands on — precisely the people it was for. (A screen reader *can* still
  traverse a disabled button in browse mode, so "unreachable" overstates it; but
  the `title` tooltip genuinely never appeared, because the shared button styles
  set `disabled:pointer-events-none`, so a disabled button fires no hover event
  at all.) Each of the five sections now renders a single banner at the top —
  "You have view-only access to this area", plus what that section specifically
  cannot be changed — in the normal reading order and in a polite live region,
  so it is announced when the session resolves and met *before* the dead
  controls rather than never. The live region itself is mounted from the first
  paint, ahead of each section's "Loading…" state, and only its *content*
  appears when access resolves: a live region injected already-populated is
  silently dropped by some screen reader and browser combinations. The buttons
  stay disabled exactly as before; only the explanation moved. This was scoped
  to Booking Policies; it has since been rolled across the whole admin tree
  (#2160, below).

  Second, the group discount card's Save is no longer clickable while the form
  is unchanged. Opening **Edit** and clicking **Save** without touching a field
  used to re-PUT, and the route writes its `group-discount.update` audit entry
  and busts the public-page cache unconditionally — so the audit trail collected
  entries asserting policy changes that never happened. There is one deliberate
  exception, because the GET **synthesises** the default values when no row has
  ever been saved: on such a club the form can never differ from its snapshot,
  so gating on that comparison alone would have made creating the row
  unreachable and left the setup checklist reporting "Group discount: using
  defaults" forever. The GET now reports whether a row is actually persisted,
  and the card treats "no row yet" as savable — a first save is a genuine
  creation, so its audit entry is accurate. A **failed** load deliberately does
  not get that exception: the fallback shown in the form is the same defaults
  object, and treating it as "no row yet" would let one click overwrite a real
  configured policy. No pricing behaviour changed — a missing row and a disabled
  row were already equivalent to every pricing reader.

  **The same no-op protection now covers the other three sections**, which were
  hand-rolled create/edit forms with no draft/snapshot pair at all. Booking
  periods, minimum night stay, and the default cancellation policy now track
  real dirtiness through the shared `useSectionEditState` hook, so **Update
  Period**, **Update Policy**, and **Save Default Policy** stay greyed out until
  the form actually differs from what is stored — and light up again the moment
  it does, or go back to grey if you undo the change by hand. That closes two
  more audit-erosion paths of exactly the kind #2143 describes: the cancellation
  write route logs `cancellation-policy.update` unconditionally, and the
  per-period write route logs a `booking-period.update` entry carrying a
  `before`/`after` pair *even when the two halves are identical*. Neither is
  reachable from the UI any more, and both are fixed at the form layer rather
  than by bolting an ad-hoc comparison onto the routes. Because these sections
  edit rows rather than one config object, each **open editor** gets its own
  draft/snapshot pair keyed on the row being edited; the list around it stays
  ordinary state, and the row-level Activate/Deactivate/Delete buttons stay
  DIRECT actions rather than becoming draft-and-Save ones — they still write on
  the click, they just write once (see the single-shot guard below). The
  first-save exception carries over where it
  applies: creating a period or a minimum-stay policy is always savable (there
  is no stored row to be unchanged from), as is the first cancellation policy on
  a partition that has none — the club-wide rules on a club that never saved
  them, or a lodge override being created — but, as with the group discount, a
  **failed** load never gets that exception, so a load error can never turn into
  a one-click overwrite of a real policy. Comparisons are semantic rather than
  literal: a re-ordered but otherwise identical set of refund rules is not a
  change (the routes sort before storing), and neither is ticking a trigger day
  and unticking it again.

  For multi-lodge clubs, the same "a failed load must not become a write" rule
  now also covers the **scope switch**. If you pick a lodge and its policy fails
  to load, the section says so and shows nothing else: previously the club-wide
  policy left on screen would have been relabelled as that lodge's override,
  offering a **Remove override** that wrote an audit entry while deleting
  nothing, and a Save that would have created an override out of rules you never
  chose for that lodge. Three smaller editor fixes ship alongside: clicking
  **Edit** again on the row you already have open now resets the form instead of
  keeping the abandoned draft, **Cancel** clears the error the editor raised, and
  if the server's reply to a *create* cannot be read the form still closes — so
  the obvious retry cannot quietly create a second period or policy.

  **A failed load now stops the section everywhere, not just on a scope
  switch.** Three related holes closed. If the cancellation policy fails to load
  on ARRIVAL — not after switching lodge, just an ordinary failed page load — the
  section used to render the full **Default Policy** editor over its own
  hard-coded starting rules, indistinguishable on screen from the club's real
  refund schedule. A pristine Save was already blocked, but the realistic path
  was not: click **Edit**, change one field, **Save**, and the write replaced the
  club-wide rules wholesale with values nobody had ever configured. It now shows
  the same "Could not load…" card a failed lodge switch shows, with no editor at
  all. **Date-Specific Periods** and **Minimum Night Stay** got the same
  treatment, which they had been missing entirely: a failed switch there left the
  previous scope's rows on screen under the new scope's heading, with **Edit**,
  **Delete**, and **Activate/Deactivate** all live over them — so a click acted
  on the partition the admin thought they had left. Both now list nothing and say
  so, and switching scope closes any editor that was open. Two smaller
  scope-timing fixes ship with it: **Create override** can no longer land on the
  lodge you switched TO while its seed was still loading, and the "Override saved
  for …" confirmation now names the lodge that was actually written rather than
  whichever one is selected when the reply arrives.

  **Activate/Deactivate is now single-shot, and it is announced.** Those row
  buttons are one-click writes, never covered by the Save dirty gate, and they
  read the row's current state from a list that only refreshes afterwards — so a
  quick double-click sent the same value twice and recorded the second as an
  update whose "before" and "after" were identical, the exact #2143 harm from a
  different direction. Each button is now disabled for the round trip and
  guarded against the repeat click. Separately, the box that reports the outcome
  of every booking-policy save had no live region at all, so neither a success
  nor a failure — including the "This change was not saved" message for a
  permissions change mid-edit — was announced to a screen reader. Failures are
  now assertive (they contradict what you believe just happened) and
  confirmations polite, both in regions registered before the message lands. And
  an active minimum-stay row no longer shows two different buttons both labelled
  **Deactivate**: the reversible pause keeps that name, and the destructive one
  is now **Delete**, which is what it is. (**Delete** is a soft delete: the row
  is taken out of use and a `delete` audit entry is recorded, but it stays
  listed as inactive and **Activate** brings it back. The guide previously said
  it removed the policy "for good", which was never what the code did.)

  **The section frame no longer disappears while a scope loads.** All three
  scoped sections — cancellation policy, Date-Specific Periods, Minimum Night
  Stay — now keep the view-only banner, the message area, and the **Rules for**
  select on screen in every state, and swap only the cards below them. Two
  things were broken by rendering the loading state above all that. A keyboard
  or screen-reader admin who changed scope from the **Rules for** select had
  that select removed from the page for the whole round trip, dropping their
  focus and forcing a full re-traverse to change scope again; and the message
  area was mounted already carrying an error whenever the FIRST load failed,
  which is the one thing a live region must never do if the message is to be
  announced reliably. Finally, the "Could not load…" card now offers **Try
  again**, so recovering from a failed load is one click instead of a page
  reload.

## 0.12.2 - 2026-07-20

- Release classification: patch public reference release. As with `v0.12.1`, the
  version is a deliberate patch bump chosen by the owner even though the range
  carries feature work — most additions are opt-in and flagged off by default.
  Unlike `v0.12.1`, however, this release is **not** purely additive: it lands
  the first **destructive contract migration** since the expand/migrate/contract
  series began (legacy-structure contraction E13, the blue/green-safe subset of
  #1939) plus a second breaking column-drop migration (member-grouping
  multi-select age tiers), and it changes one default behaviour (admin
  post-login landing). Both breaking migrations are old-colour compatible under
  a prompt cutover but require the `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`
  operator acknowledgement. Read `docs/releases/v0.12.2.md` and the
  `v0.12.1 -> v0.12.2` section of `docs/UPGRADING.md` before deployment.

- **Production Xero lock-date 503 fix and Xero reliability (#2101/#2110,
  #2105/#2116, #2089/#2096).** The urgent fix: retroactive (past-dated) booking
  creation returned a 503 "Could not verify the Xero lock dates" whenever the
  connected Xero organisation actually **has** lock dates set — the exact case
  the guard exists for. Root cause (confirmed from production logs): xero-node's
  `ObjectSerializer` deserialises an MS-JSON `/Date(...)/` payload into a JS
  `Date`, so `parseXeroLockDate`'s `value.slice(0,10)` threw and the guard failed
  closed; reconnecting could never fix it. The parser now accepts `string |
  Date`. On top of the fix, a **lock-date error taxonomy** classifies the guard's
  503 as `reconnect_required | rate_limited | transient` with cause-specific,
  admin-only reason copy (member bodies byte-identical), plus a click-only live
  **connection-health probe** (`GET /api/admin/xero/status?probe=1`) replacing
  the token-row-presence "Connected" chip, and a finance-sync
  `parseOptionalDateOnly` made `Date`-aware (SDK-coerced due-dates no longer
  drift into the no-due-date aging bucket). Separately, the Xero contact-create
  gate is shrunk to require only first name + last name + email — phone, DOB,
  joined date, and addresses become optional, with an informational
  "profile incomplete" note and cleaner sparse-member payloads (no empty phone
  block).

- **Membership-type lifecycle: age-exempt types, bulk assignment, Xero import,
  and item-code paid-detection (#2106/#2118, #2107/#2126, #2108/#2127,
  #2109/#2123).** Membership types whose allowed-age-tiers list "N/A (no age)"
  become the single source for genuinely age-exempt members: a type allowing
  only N/A **forces** every current-season holder to `NOT_APPLICABLE`, a type
  listing N/A among person tiers lets admins hand-pick it per member, and the
  rule is enforced through one shared helper at every ageTier write site
  (assignment, admin edit, self-serve profile, family confirmation, set-role
  grant/revoke, season roll-forward). Admins can **bulk-assign** membership type
  to up to 100 selected members from the members page (aggregate preview →
  required reason → per-member outcomes, HMAC preview-token gated, per-member
  audits, per-member Xero group syncs suppressed in favour of one batched
  reconcile). Xero **Setup import** gains a mapping mode — age tiers (default),
  membership types, or both — mapping contact groups onto active types, never
  overwriting an existing current-season assignment and fully reporting what it
  skipped, with `membership:edit` gating on type-mapping imports. And an opt-in
  **"use membership fee item codes"** mode lets subscription paid-detection look
  through to the per-type+tier item codes the fee schedule already stamps on
  invoices (default off = today's single-code behaviour byte-for-byte;
  strong-match-first selection; overlap warnings).

- **Xero member-grouping multi-select age tiers (#2093/#2111).** A grouping rule
  can now target any subset of age tiers (`XeroContactGroupRule.ageTier` →
  `ageTiers AgeTier[]`, empty = all tiers) with specificity-based overlap
  resolution and a fingerprint serializer proven byte-identical to the old one
  for the migrated cases (no spurious full regroup on the first post-deploy
  resync), plus a "Refresh from Xero" button and a "Last synced" header. Its
  migration (`20260719170000_xero_grouping_age_tiers_multiselect`) backfills
  `X → [X]` / `null → []` and then **drops** the old scalar `ageTier` column — a
  breaking column-drop that needs the blue/green acknowledgement (see notes
  below).

- **Post-login landing for admins + per-member preference (#2090/#2098).** After
  sign-in, a member with admin access and no set preference now lands on their
  admin area (`getFirstAccessibleAdminHref(matrix) ?? /dashboard`) instead of the
  member dashboard — applied entirely by the application redirect resolver, so
  every existing admin lands on their admin area on the first login after
  upgrade. This includes read-only admins and finance-only viewers (e.g. a
  finance-only viewer lands on `/admin/payments`). A new typed, nullable
  `Member.postLoginLanding` enum column (`MEMBER_DASHBOARD | ADMIN_DASHBOARD`,
  null = role default) backs a profile **Account Information** toggle shown only
  to members with an accessible admin page; there is no free-text path and no
  open-redirect surface. A genuinely deep-linked `callbackUrl` still wins; a
  value the login flow itself materialised (the 2FA detour, a provider return
  URL) never counts as explicit. A member with no admin area — including a
  demoted admin holding a stale preference — still lands safely on `/dashboard`,
  never a 403 loop.

- **Admin and booking UX (#2092/#2112, #2091/#2099, #2088/#2097, #2102/#2113,
  #2103/#2114, #2104/#2115, #2124/#2128).** A Ctrl/Cmd-K admin **feature search**
  palette plus a sidebar Search button, derived from the visible-nav single
  source so it can never reveal an inaccessible page. The admin **dashboard**
  key-card row re-targets the four bookings-officer surfaces (Bookings, Hut
  Leader, Roster, Bed Allocation) with actionable "work to do" counts. The admin
  **booking calendar** no longer overflows into the next week's row
  (auto-expanding rows capped at six lanes, a per-day "+N more" chip, greyed
  finished days). The `/finance` and `/lodge` shells now inherit the club theme
  (they were rendering the default teal), guarded by a brand-colour source
  contract test. `/admin/security` now follows the settings-page Edit→Save
  convention, makes the magic-link TTL persistable, and fixes a stale-clobber
  that silently reverted other module toggles. The member booking-edit panel
  finally **renders the required justification field** for a minors-without-adult
  edit (previously the 400 surfaced as bare red text), with a machine-readable
  `REVIEW_JUSTIFICATION_REQUIRED` code. And an in-progress stay's **minimum-stay
  rule is now evaluated against the whole contiguous stay** — a one-night
  extension of an already-valid stay is no longer wrongly rejected — surfaced as
  an advisory warning on the quote.

- **Legacy schema contraction E13 — destructive, safe subset of #1939 (#2132).**
  The first contract migration of this release removes two provably-dead legacy
  structures — the `EntranceFee` table (superseded by JoiningFee in E5 #1931) and
  the `AgeTierXeroAcceptedContactGroup` table (converged into
  `XeroContactGroupRule` in E8 #1934) — plus the orphaned `entranceFeeAmountCents`
  account-mapping row. An independent drop-proof review re-verified zero readers
  against the `v0.12.1` tag (the colour draining during the deploy). The
  `EntranceFeeCategory` enum, `SeasonRate` (the live public `{{hut-fees}}` embed
  reader), `MembershipTypeAgeTier`, and the `XeroItemCodeMapping.isMember` /
  `AgeTierSetting.xeroContactGroup*` columns are all deliberately **kept or
  deferred** to follow-ups #2129/#2130/#2131. The destructive `DROP TABLE`s
  require the blue/green acknowledgement (see notes). The #2130 **runtime-prep**
  also ships in this release (#2133): the three remaining no-`select` queries on
  `XeroItemCodeMapping`/`AgeTierSetting` now name only their consumed columns, so
  the deferred column drops become blue/green-legal next release.

- **Docs, CI, and tests (#2083/#2085, #2117/#2125).** The member-facing user
  guide (`docs/user-guide/`) is now mirrored one-way to the GitHub wiki by a
  push-triggered workflow plus `npm run docs:wiki-sync`. The E2E seed fixtures
  were made relative and never-expiring so the suite stops going stale at date
  boundaries.

- **Migration/deployment notes:** **take a fresh, restore-tested backup before
  deploying — this release contains destructive schema changes.** Four migrations
  apply. Two are expand/additive: `20260719150000_add_post_login_landing` (a new
  `PostLoginLanding` enum + a nullable `Member` column with no default; ledgered
  `old_code_compatible=yes`) and `20260719180000_add_use_fee_schedule_item_codes`
  (a single flagged-off boolean on the cold single-row `MembershipLockoutSettings`
  table — additive with a constant default, so ledger-exempt under the same
  policy as v0.12.1's `add_login_security_setting`). **Two are breaking `contract`
  migrations that each require `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`:**
  `20260719170000_xero_grouping_age_tiers_multiselect` backfills then **drops** the
  scalar `ageTier` column (window-bounded, admin-only — between migrate and
  cutover the old colour's grouping/membership-admin reads error with
  column-does-not-exist; the live grouping sync fails closed and retries
  post-cutover, so deploy with that admin traffic idle and cut over promptly),
  and `20260720120000_contract_drop_entrance_fee_and_agetier_xero_group` drops the
  two dead tables (old-colour compatible — no deployed SQL names them — but a
  `DROP` is breaking by class). Both carry `old_code_compatible=yes` ledger rows
  and name their `previous_expand_release`. No migration makes a Xero, Stripe, or
  SES call, and no member is re-grouped in Xero by any migration. See
  `docs/UPGRADING.md` for the complete operator checklist.

## 0.12.1 - 2026-07-19

- Release classification: patch public reference release. The version is a
  deliberate patch bump chosen by the owner even though the range carries
  feature work, because every addition is additive and flagged off by default:
  it brings all changes landed after `v0.12.0` into one supported tag, with
  five migrations (all expand/additive, no contract). It adds optional sign-in
  methods (per-club password-complexity policy, email magic-link, Google
  OAuth — the last two default off), per-age-tier membership billing (annual
  fees and subscription requirement), Lobby Display template/builder polish, a
  full operator and member documentation library, and a screenshot-forward
  README, alongside a CI safety-gate hardening. Read
  `docs/releases/v0.12.1.md` and the `v0.12.0 -> v0.12.1` section of
  `docs/UPGRADING.md` before deployment.

- **Optional sign-in methods (epic #2030: #2033/#2037, #2034/#2040 —
  superseding #2039, #2035/#2043).** A new admin **Login & Security** page
  (`/admin/security`) adds a per-club password-complexity policy — minimum
  length 8–64 (default 12), four character-class toggles (default off), a
  fixed 128 maximum — enforced only at password-set time through one shared
  validator, with live policy hints on the reset/change forms via a public
  `GET /api/auth/password-policy`. An un-configured club is byte-identical to
  today (absent `LoginSecuritySetting` row falls through to the code default
  `min(12)`), and existing passwords are never re-validated
  (`forcePasswordChange` is the adoption lever). Two optional sign-in methods,
  both **module-flagged off by default**, join password login without
  replacing it: **email magic-link** (`ClubModuleSettings.magicLink`) issues a
  single-use hashed token whose TTL the club sets on the security page
  (default 15 min, clamp 5–60); and **Google OAuth**
  (`ClubModuleSettings.googleLogin`) works by profile-initiated linking only —
  a signed-in member links their verified Google account from their profile,
  sign-in then resolves solely by the pinned Google subject id
  (`Member.googleSub @unique`), never by email match and never auto-provisioning,
  with the same `canLogin`/`active`/`emailVerified`/2FA gates as password
  login and per-club `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` credentials
  (runbook in `CONFIGURATION.md`). Google sub is deliberately excluded from
  member-merge field-fill so a login identity is never inherited.

- **Per-age-tier membership billing (#2041/#2051, #2067/#2072, #2069/#2071,
  #2068/#2073).** Membership types gain a third subscription behaviour,
  **Required based on age tier** (`BASED_ON_AGE_TIER`), that defers the
  subscription-required answer to the existing per-tier
  `AgeTierSetting.subscriptionRequiredForBooking` flag, so one type can bill
  older tiers while exempting younger ones; billing liability is fixed by age
  at the start of the club financial year, exempt members get an authoritative
  `NOT_REQUIRED` season row, and `REQUIRED`/`NOT_REQUIRED` types are
  byte-unchanged. Annual membership fees gain the same **flat (all ages) vs
  per-tier** shape the joining fee already carried: a nullable
  `MembershipAnnualFee.ageTier` (existing rows are the flat fallback — no
  backfill), tier-first resolution, and per-family fees held flat-only
  (enforced at the API, a DB `CHECK`, and config-transfer). The membership-type
  editor adds an explicit **"N/A (no age)"** (`NOT_APPLICABLE`) allowed-tier
  option (sorted last, opt-in, excluded from the API default). The annual-fee
  editor replaces free-text Xero Account/Item inputs with searchable pickers
  (ACTIVE revenue accounts / sales-capable items) fed by the existing
  admin-gated proxy endpoints — falling back to manual entry on Xero
  disconnection, never hard-blocking — surfaces the resolved default account,
  and shows the fee-level proration rule (no billing-math change).

- **Lobby Display template pack, guided builder, and night-columns fix
  (#2047/#2055, #2048/#2058, #2056/#2062).** A six-board template pack ships
  four refresh-on-reseed built-ins (*Room by room*, *Week ahead*, *Lodge
  operations*, *Welcome kiosk*) plus two extras in an import bundle, so every
  display module is exercised by at least one built-in. A guided visual
  **builder** at `/admin/display/builder` (ADR-004) composes skeletons, a
  module palette, per-zone settings, and a sandboxed live draft preview through
  the unchanged save contract, with the existing textarea editors retained as
  Advanced mode and no schema change; the privacy floor stays enforced
  structurally. Night-columns is rescoped as an honest permanent 3-night board
  (`NIGHT_COLUMNS_MAX_DAYS` 5 → 3) matching the device data window. The Lobby
  Display module remains off by default.

- **Documentation foundation, operator and member guide library (#2049/#2054,
  #2050 via #2057/#2060/#2061/#2064/#2063).** A docs foundation lands a
  `docs/STYLE_GUIDE.md`, an audience-first `docs/README.md` hub, five curated
  `docs/ARCHITECTURE.md` mermaid diagrams, a `docs/COVERAGE_MATRIX.md` mapping
  every admin route area to coverage, an advisory `docs-link-check` CI workflow
  with a matching local `npm run docs:linkcheck`, and a Playwright screenshot
  harness (`npm run docs:screenshots`). On top of it, **65 operator guides**
  in `docs/guides/` (four batches: bookings & capacity, membership &
  applications, lodge operations & lobby display, and comms/content/support
  platform) plus a fifth batch of **member-facing journey guides** in
  `docs/user-guide/`, each written against the running seeded app with
  seeded-data screenshots, closing the coverage matrix to zero gaps.

- **Screenshot-forward README (#2076/#2077).** The root `README.md` is
  rewritten as a marketing front page — reproducible hero art, badges, a
  benefit-led feature grid, a screenshot gallery, a native mermaid
  architecture diagram, and a condensed quickstart — with two reproducible
  dev-only asset harnesses (`npm run docs:readme-art`, `npm run docs:demo-gif`)
  and its former deep operational content relocated into the docs it
  duplicated. No runtime app code changes.

- **Fixes, CI, and dependencies (#2045/#2052, #2046/#2053, #2038/#2042,
  #2070).** The membership-types editor closes on a successful edit save and
  regains a dirty-guarded header X; `/admin/display` drill-down leaves regain
  the shared `BackLink` (with a repo-wide back-affordance normalisation); the
  blue/green migration validator's session-clock gate is no longer blinded by
  dollar-quoted SQL (the splitter is now dollar-quote-aware for arbitrary
  Postgres tags and fails loudly on an unterminated quote — one benign,
  already-deployed case recorded in an exact-name-keyed allowlist); and
  `github/codeql-action` is bumped to 4.37.0.

- **Migration/deployment notes:** deploy in a normal window after a tested
  backup — **no contract migration** this release. Five expand/additive
  migrations apply. Four have ledger rows in
  `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, all `old_code_compatible=yes`:
  `20260718130000_add_magic_link` and `20260719120000_add_google_oauth`
  (flagged-off boolean(s) + a new/nullable column; the `add_google_oauth`
  unique index builds over an all-NULL `Member.googleSub`, briefly blocking
  `Member` writes — use `CREATE UNIQUE INDEX CONCURRENTLY` if `Member` is very
  large), `20260719130000_add_based_on_age_tier_subscription_behavior` (a pure
  additive `ALTER TYPE ... ADD VALUE`), and `20260719140000_annual_fee_age_tier`
  (a nullable catalog-only `ADD COLUMN` plus index/constraint reshaping on the
  cold `MembershipAnnualFee` table). The fifth, `20260718120000_add_login_security_setting`,
  is a single additive cold config table with no FK and needs no ledger row
  (same policy as v0.12.0's ledger-exempt additive migrations). Two flagged-off
  sign-in modules mean nothing changes at cutover until an admin enables them.
  **One operator caveat:** because the old colour's fee resolver does not
  filter by age tier, do **not** create per-age-tier annual-fee rows until the
  cutover completes — a per-tier row is not invisible to the old resolver and
  could be selected for a member of any tier and mis-price them (over-resolve).
  No migration makes a Xero, Stripe, or SES call. See `docs/UPGRADING.md` for
  the complete operator checklist.

## 0.12.0 - 2026-07-18

- Release classification: minor public reference release. This is a large
  feature, configuration, and correctness release over `0.11.0`, with 25
  migrations (24 expand/additive, one contract). It adds the flagged-off Lobby
  Display module, exclusive whole-lodge holds, un-flagged core multi-lodge
  operation, database-first club identity and configuration with boot-time
  self-heal, authoritative fee schedules with subscription and joining-fee
  billing, and rule-based Xero member grouping, alongside broad
  booking-settlement, payment, and Xero/finance hardening. Read
  `docs/releases/v0.12.0.md` and the `v0.11.0 -> v0.12.0` section of
  `docs/UPGRADING.md` before deployment.

- **Lobby Display module (#1911, upstreaming fork PRs #109–#187).** A new
  flagged-off module renders per-lodge lobby screens: admin-authored layouts
  and templates (room cards, night columns, status board), a per-lodge notice,
  a name-granularity control over how guests appear, and registered display
  devices, managed from a single Lobby Display admin hub. The module flag
  (`ClubModuleSettings.lobbyDisplay`) defaults off, so nothing changes until a
  club enables it; the schema lands as the single consolidated
  `add_lobby_display` migration. Guest phone numbers appear on screens only
  under a two-sided opt-in (#133–#136, #151): the member must opt in **and**
  the lodge must enable it, enforced in the serialisers, with both flags
  defaulting off — and only ever for adult members; youth and child phone
  numbers are never shown. Documentation lives under `docs/lobby-display/`.

- **Exclusive whole-lodge holds (#144–#148, #166, #180, #181, #183, #185,
  #187; ADR-001 in `docs/exclusive-booking/`).** A school/group booking
  request can now ask for sole occupancy of the lodge
  (`exclusivityRequested`), and an admin approving it — or acting directly —
  can place a whole-lodge hold on the resulting booking. While the hold
  stands, capacity enforcement blocks every other booking for those nights,
  the hold is visible on availability and admin surfaces, and bed allocation
  respects it. Hold placement, lifecycle, and
  confirm-pending conversion are guarded by status checks and advisory locks
  so concurrent bookings cannot slip past a hold. All new fields default off
  in `add_exclusive_hold_fields`.

- **Multi-lodge is now core, not a module (#138, #140–#143).** The `multiLodge`
  module flag is removed and lodge routes are un-gated: every installation is
  a multi-lodge installation with at least one (default) lodge. The vestigial
  `ClubModuleSettings.multiLodge` column is retired but not yet dropped — the
  drop is deferred to a future contract migration (fork #129), reads are
  already drop-safe (fork #150), and ADR-005 records the decision (#140) —
  navigation is lodge-aware (#141), the admin home becomes a lodge hub
  (#142), and backwards compatibility for existing single-lodge installs is
  preserved (#143) — a single-lodge club sees no operational change.

- **Authoritative fee schedules and membership billing (#1855/#1858,
  #1857/#1861, #1870/#1879, #1930/#1958, #1931/#1968, #1932/#1973,
  #1933/#1974, #1936/#1954, #1941/#1989, #1944/#1959, #1896).** Booking,
  joining, and annual membership fees now live in database fee schedules that
  admins edit and save (`docs/AUTHORITATIVE_FEES.md`): season rates are keyed
  by membership type rather than a member/non-member boolean, joining fees are
  modelled per membership type and age tier, and annual fees break into
  invoice-line components. Durable subscription-billing workflow tables drive
  membership invoicing, families can choose a billing mode and billing member,
  manual mark-paid actions record provenance and paid-up semantics are
  clarified, membership application approval maps applicants onto the new
  model, fee presentation reaches the public pages behind a double-opt-in
  `{{annual-fees}}` embed, and configuration transfer carries fee
  configuration. Day-one amounts are backfilled from the existing
  configuration; the legacy tables are retained (not dropped) so the old
  colour prices season and annual fees identically during cutover
  (entrance/joining fees carry a window-bounded old-colour caveat — see the
  Migration/deployment notes).

- **Database-first club identity and configuration, with boot-time self-heal
  and DR auto-import (#1929/#1957, #1980/#1991, #1981/#1999, #1982/#2013,
  #1983/#2005, #1984/#2004, #1985/#2014, #1986/#2015, #1987/#2019,
  #1988/#2028).** Club name/short name/hut-leader label/Facebook URL, lodge
  address, capacity, age tiers, and email settings now resolve database-first
  with config-file fallback; sync consumers and the setup wizard read and
  write the database, legacy email environment variables are retired, and a
  boot-time config self-heal backfills missing DB values from the effective
  configuration without ever overwriting an admin edit. A bootstrap-safe
  loader keeps boot resilient when the database is unreachable. For disaster
  recovery and cloning, `CONFIG_BUNDLE_IMPORT_PATH` auto-imports a
  configuration bundle at boot — only when the database holds no non-seed
  configuration, so it can never clobber a live install. Applying an
  interactive configuration import now refuses to proceed when backups are
  enabled but the pre-apply backup was not durably uploaded to S3 (#1910),
  retired email environment variables log a boot warning when still set
  (#2021/#2022), and age tiers are now editable as a contiguous subset,
  letting clubs run fewer than four tiers (#2009/#2027).

- **Xero and finance hardening, plus rule-based Xero member grouping
  (#1893, #1897, #1900/#1916, #1902, #1908, #1909, #1917, #1922,
  #1934/#1953, #1961/#1972).** Group-settlement application retries safely,
  Xero write durability and credit deallocation are hardened, season billing
  runs transactionally, entrance-fee enqueueing is deduplicated (with a
  partial unique index guaranteeing at most one active entrance-fee invoice
  link per member), a membership lifecycle review race is closed, phantom
  Xero payments on supplementary-invoice retries are prevented, and
  capacity-refund recovery is durable. Xero contact-group membership is now
  driven by admin-editable grouping rules with a server-persisted dry-run
  that must be fresh before a bulk re-sync (`docs/XERO_MEMBER_GROUPING_RUNBOOK.md`).
  Webhook dedup gains a processing lease so redelivered events reprocess
  safely instead of being dropped.

- **Booking settlement, lifecycle, and date correctness (#1878/#1892,
  #1881/#1919/#1921, #1883/#1899, the #1888 cluster
  (#1894/#1895/#1898/#1906/#1914/#1918), #1992/#2006, #1993/#2010,
  #2003/#2018, #2012/#2024, #2029/#2032).** NZ date-only handling is enforced
  end to end, lock topology is corrected and the split-child cancel race is
  closed, group-settlement readmission works, cron isolation and date-only
  guards are tightened and an error-message leak is fixed, a double-charge
  window is closed, terminal booking-request and hold states are made truly
  terminal, deferred-payment state has a single source of truth, and bookings
  now complete at the end of the checkout day (NZ) — enabling priced,
  capacity-checked, cancel-guarded checkout-day extensions. Payment-link email
  reliability is improved (#1885/#1904).

- **Split-booking settlement and payment UX (#1967/#1995, #1942/#1977,
  #1976/#1996, #1975/#2001, #1994/#2000, #2002/#2017).** Internet Banking
  settlement of split bookings is correct, the split flow's UX is clearer,
  the pay step shows the right amount, admin bookings render split children
  as nested subrows, the register-split notifications become admin-editable
  email templates, and joiners are labelled accurately.

- **View-only admin access is enforced across admin surfaces (#1927/#1949,
  #1940/#1998, #1997/#2031).** Admin content editors, route permissions, and
  action buttons across bookings, membership queues, member detail
  (lifecycle, deletion, credit, family), finance, support, and communications
  are gated for view-only access roles: a role without write permission sees
  the data but cannot mutate it, at both the UI and the route level.

- **Member deletion requests, merge, and duplicate-capture recovery
  (#1938/#1948/#1960, #1937/#1963, #2007/#2023, #2008/#2025, #1935/#1956).**
  Admin-initiated member deletion requests are surfaced with a dedicated,
  separately-mutable notification preference; duplicate members can be merged;
  duplicate-capture auto-refunds get a dedicated admin-editable email template
  and a narrative-safe booking-history event; and admins can book on behalf
  of a non-member.

- **Member CSV import can create already-cancelled members (#1946/#1990).**
  The member import gains an optional **Cancelled Date** column. A row with a
  cancelled date is created in the cancelled end-state — inactive, non-login,
  with `cancelledAt` set to the given NZ date-only value — matching what the
  normal admin cancellation flow produces, minus notifications: the import
  sends no cancellation email and performs no Xero/Stripe work (a freshly
  imported member has no Xero contact). A cancelled row never claims the
  login for a shared email, and the cancelled date may not be in the future.
  The import still only creates members, so a row matching an existing member
  is skipped unchanged — cancelling an existing member remains an admin
  cancellation-flow action.

- **Public content, generic starter copy, and committee CRUD retirement
  (#1856/#1862, #1864/#1866, #1928/#1950, #1945/#1964, #1947/#1969).** Public
  page content gains token embeds behind explicit visibility gates
  (`docs/PUBLIC_PAGE_CONTENT_TOKENS.md`), starter privacy/terms/FAQ copy is
  genericised (admin-edited pages are left untouched), copy quick-wins and a
  content scrub remove club-specific wording, and logo alt text is fixed. The
  legacy standalone committee directory and its admin CRUD are removed — the
  member-linked committee roles/assignments system from v0.11.0 is now the
  only committee source, and the `drop_committee_member` **contract
  migration** drops the retired table (see Migration/deployment notes).
  Saved theme colours now also apply to outbound emails (#1912/#1915).

- **Performance, load, and accessibility (#1884/#1903/#1905/#1907/#1920,
  #1889/#1891/#1901, #1869/#1890).** Admin bookings are paginated, the
  database pool is sized for the deployment, a k6 load harness and
  load-stability fixes land, form errors and UI states meet accessibility
  expectations, and admin UI polish rounds out the sweep.

- **CI, security, dependencies, and docs (#1865, #1867/#1868, #1871/#1872,
  #1873, #1874, #1876/#1877, #1926/#1955, #1962/#1971, #1966/#1970, #1979,
  fork #169/#170, #15/#1863/#1913).** Semgrep static analysis joins CI
  (#1865) and its findings are remediated (#1867/#1868), GitHub Actions
  dependencies are updated, Xero error
  shapes are corrected, a production-hardening review lands, ops docs are
  corrected, the agent orchestration workflow is documented, non-member and
  identity-smoke E2E suites are added, a migration timestamp collision is
  repaired, the attack surface is documented
  (`docs/SECURITY-ATTACK-SURFACE.md`), and the design fork is synced.

- **Migration/deployment notes:** deploy in a quiet, low-write window after a
  tested backup. One **contract migration**,
  `20260714140000_drop_committee_member`, removes the legacy standalone
  committee directory table: its member-linked replacement shipped and was
  backfilled in v0.11.0, so the drop loses no data beyond the retired
  directory itself — no assignment or contact data lives only in the dropped
  table — but the old colour's admin committee CRUD routes error between
  migrate and cutover. Idle or drain old-colour admin traffic, cut over
  promptly, and supply the documented
  `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` override together with a
  non-empty `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` acknowledgement. The
  `joining_fee_model` and `xero_member_grouping` expand migrations carry
  window-bounded old-colour caveats described in
  `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`: once `joining_fee_model` re-keys
  the entrance-fee Xero item-code mappings, the old colour resolves both the
  item code and the amount of a new entrance-fee invoice from the legacy
  flat mappings — it can mint a wrong per-category amount, or silently skip
  the invoice as SUCCEEDED when the flat amount is unset — so membership
  approvals and entrance-fee minting must be fully idle on the old colour
  from migrate until cutover (operations queued before the window carry
  frozen amount/item payloads and replay safely); and `xero_member_grouping`
  converges grouping rules, so avoid grouping-rule saves on the draining old
  colour. No migration makes a Xero call, and no member is re-grouped until
  the admin-run dry-run and bulk re-sync in
  `docs/XERO_MEMBER_GROUPING_RUNBOOK.md`. See `docs/UPGRADING.md` for the
  complete operator checklist.

## 0.11.0 - 2026-07-13

- Release classification: minor public reference release. This is a large
  feature, operator-UX, accessibility, and multi-lodge release over `0.10.1`,
  with 30 migrations. It adds first-class multi-lodge operation, configuration
  transfer, declared partner/double-bed sharing, safer admin booking overrides,
  expanded admin email controls, and the Restrained Alpine application design
  system. Read `docs/releases/v0.11.0.md` and the `v0.10.1 -> v0.11.0` section
  of `docs/UPGRADING.md` before deployment.

- **Multi-lodge operation is now first-class (#1568).** Lodge-scoped booking,
  room/bed, season, rate, instruction, waitlist, roster, kiosk, hut-leader,
  school/group-request, promo, locker, work-party, and member-access flows now
  resolve an explicit lodge. Admins can choose the default lodge, configure
  lodge-specific access, and operate calendars and queues without silently
  crossing lodge boundaries. The migration sequence seeds the existing
  single-lodge installation as the default, expands/scopes dependent records,
  and then enforces the required lodge identities.

- **Restrained Alpine design foundation and application-wide UX sweep
  (#1800).** Authenticated, admin, login, and school/request surfaces now share
  configurable brand accent/neutral/font tokens, accessible semantic status
  colours, dark-mode-safe alerts and focus states, reduced-motion handling,
  skip links, responsive tables, and reusable status, occupancy, empty/loading,
  filtering, pagination, table, calendar, and section-navigation primitives.
  Admin lists, bookings, payments, Xero sync, members, bed allocation, lodge
  kiosk, dashboards, and the public theme were migrated to the shared system.

- **Admin booking operations gained explicit, audited recovery paths.** Full
  Admins and Booking Officers can create retroactive bookings (within the
  365-day/Xero-lock-date guard), override locked stay dates by shifting or
  repricing, explicitly admit over-capacity bookings, place/remove capacity
  holds, and choose whether applicable admin-initiated actions email members.
  Finished-stay side doors were closed, linked change requests are fulfilled,
  and over-capacity intent now survives payment settlement rather than being
  undone by a later capacity re-check.

- **Bed allocation and shared-double occupancy were expanded.** Admins can
  manage richer bed types, move whole stays more predictably, preserve draft
  work, distinguish bookings visually, enforce cross-booking minor/adult
  separation in automated placement, and place a confirmed partner as the
  second occupant of a shareable double. A lodge's configured maximum sleeping
  capacity now remains a hard ceiling even when more beds are installed.

- **Finance, membership, setup, and operational administration were
  hardened.** Applied-credit allocation and credit-restore deduplication make
  Internet Banking cancellation/refund recovery deterministic; Xero-lock-date
  guards cover retroactive repricing; editable access-role definitions,
  permission-aware setup hubs, committee contact routing, membership-type
  retirement, lodge-aware hut-leader/roster/kiosk tools, and admin notification
  controls improve operator visibility and control.

- **Migration/deployment notes:** deploy in a low-traffic window after a tested
  backup. Four contract migrations require particular care: the induction
  result table and self-assessment fields, finance-report label fields, and
  legacy email-setting lodge identity fields are removed. The last three have
  a brief old-colour incompatibility window described in
  `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`; drain or idle the affected old-colour
  traffic, cut over promptly, and supply the documented migration-validator
  override acknowledgement. Before deployment, audit lodge capacity with the
  read-only query in `docs/CAPACITY_MODEL.md`. After cutover, verify the default
  lodge and lodge-scoped configuration, module enablement, email/lodge identity,
  booking capacity, kiosk/roster, Xero/finance reads, and the new app theme. See
  `docs/UPGRADING.md` for the complete operator checklist.

- **11 previously-hardcoded emails are now admin-editable in
  `/admin/notifications` (#1797).** Booking review approved/rejected, induction
  sign-off request, school attendee confirmation, the school manual-invoice
  admin alert, and the six group-booking settlement/join notices gained
  `EMAIL_TEMPLATE_DEFINITIONS` entries, so admins can reword them like the rest
  of the registry. Delivery stays **locked to always-send** for all 11 (they are
  member- or admin-facing and several carry action links or are operationally
  required, so they can never be content-only'd or disabled), and absent an override the shipped wording is
  unchanged. The school-attendee confirmation's `{{token}}` is now threaded into
  its template data so an override renders the confirm link. `two-factor-code`
  stays hardcoded by design (auth-critical). No money, booking capacity, or
  delivery-timing behaviour changes.

- **Admin email-notify choice extended across the remaining admin-initiated
  member emails (#1780 / #1769b, completing the sweep).** The canonical
  `notifyMember` two-button pattern (#1705/#1769a) now covers: membership
  application approve/reject (#1786), membership cancellation review
  approve/reject (#1787), member archive review + account-deletion reject
  (#1788), family-group child-request & group-create approve/reject (#1789),
  booking review (minors) approve/reject (#1790), public booking-request
  decline (#1791), and refund-appeal approve/reject (#1792). Each admin decision
  now asks, per action, whether the affected member/applicant/requester receives
  the standard outcome email — default is to notify; "without emailing" skips
  the send and records `notifyMember: false` in the audit metadata, recorded
  only on paths that would truly have emailed (honesty rule). Token-bearing and
  pipeline-critical sends keep always-send: membership-application induction
  sign-off requests, the family group-create partner invite, booking-request
  approve/quote links, and the account-deletion approval receipt. Member
  self-service flows and admin-facing alerts are untouched. No money, booking
  capacity, or provider (Stripe/Xero) behaviour changes.

- **Manual-board `MINOR_ADULT_MIX` warning-only behaviour documented as
  intended.** The deferred owner decision from #1768/PR #1775 is closed:
  automated placement paths enforce the cross-booking minor/adult invariant
  hard, while the manual allocation board deliberately stays warn-not-block as
  an admin-judgment escape hatch. `docs/DOMAIN_INVARIANTS.md` and
  `docs/STATE_MACHINES.md` now record this as the intended function
  (docs-only; no behaviour change).

- **Admin can choose whether to email members on force-confirm,
  confirm-pending-guests, and admin guest-add (#1769b).** Part of #1780 /
  #1769b, extending the #1705 cancel notify pattern to three more admin
  booking actions. The waitlist "Force Confirm" and the "Confirm pending guests
  now" tool now ask, per action, whether the member receives the standard
  booking-confirmation email — a two-button dialog ("Confirm and email member"
  vs "Confirm without emailing") shown only when an email would actually be
  sent (a force-confirm that lands PAID, i.e. a $0 stay with review resolved;
  and the confirm-pending zero-amount or charged-card outcomes). The
  admin-actor guest-add route (`POST /api/bookings/[id]/guests`) honours the
  same `notifyMember` flag at the route level (no admin UI caller). The default
  is to notify; "without emailing" skips the email and records
  `notifyMember: false` in the audit metadata (recorded only on the outcomes
  that truly send, per the honesty rule). A non-admin caller carrying the flag
  on the guest-add route is refused with a 403, so a member can never suppress
  their own booking email; member self-service behaviour is otherwise
  unchanged. Booking capacity, charges, and settlement are identical either
  way — only the member email differs.

- **Admin can choose whether to email guests when sending the chore roster
  (#1785, part of the #1769b sweep).** The "Email Roster to Guests" action on
  `/admin/roster` now asks, per send, whether to email — a two-button dialog
  ("Email guests the roster" vs "Don’t email — keep existing links"), reusing
  the retroactive-create / cancel / partner-link notify pattern
  (#1695/#1705/#1769a). The default is to notify: every affected guest is
  emailed a fresh 48-hour chore link, reissuing tokens exactly as before.
  Suppressing skips the whole send **and** leaves existing guest chore
  tokens/links intact — no token deletion, no new tokens, no email — so
  previously-emailed links keep working; the suppression is recorded in the
  audit log as `notifyMember: false` (`ADMIN_CHORE_ROSTER_EMAIL_SUPPRESSED`).
  The per-member `choreRoster` opt-out still applies on top of the notify path.

- **Email message catalogue completeness pass (#1780 docs child).** The audit
  documented the 12 live templates that had been missing from the catalogue:
  `two-factor-code`, `booking-review-approved` /
  `booking-review-rejected`, `induction-sign-off-request`,
  `school-attendee-confirmation`, `admin-school-manual-invoice`, and the six
  group-booking settlement/join messages (`group-booking-join-verification`,
  `group-settlement-receipt`, `group-join-settled`,
  `group-settlement-expired`, `group-join-released`, `group-join-cancelled`).
  These senders are hardcoded (no admin-editable template). Docs-only; no
  behaviour change. The temporary Markdown audit was subsequently retired by
  #1796; the TypeScript registry is authoritative for editable templates.

- **A deliberately over-capacity booking is no longer destroyed when payment
  lands (#1771).** Every admin over-capacity admission — on-behalf create
  (#1668/#1695/#1767), date/batch modification (#1668), waitlist force-confirm,
  confirm-pending-guests overbook (#1366), and admin capacity-hold (#1764) —
  now persists the decision on the booking (`capacityOverriddenAt` +
  `capacityOverriddenByMemberId`). Every payment-time / settlement capacity
  re-check (`markBookingPaymentSucceeded`, payment links, the non-member-hold
  cron, saved-card charge, switch-to-Internet-Banking, the Internet Banking
  invoice-paid reconcile, and group settlement) now honours that marker and
  settles the booking to its correct terminal state instead of
  cancelling+refunding, 409ing, or bumping it. This retires the #1767 v1
  carve-out that hard-blocked a non-member hold-eligible (PENDING) on-behalf
  overbook — the hold cron now confirms rather than bumps it. Members can never
  overbook; the marker only ever appears behind an explicit, audited admin act.

- **Admin can choose whether to email members when assigning or removing a
  partner link (#1769a).** The Partner card on `/admin/members/[id]` now asks,
  per action, whether the members receive the standard partner-relationship
  email — a two-button dialog ("Assign/Remove and email members" vs "…without
  emailing"), reusing the retroactive-create / cancel notify pattern
  (#1695/#1705). The default is to notify; suppressing is recorded in the audit
  log as `notifyMember: false`. The dialog appears only when an email would
  otherwise be sent: assign always, remove only for a CONFIRMED link — removing
  a still-pending link emails no one, so it removes directly and records no
  notify field. Member-facing partner flows (request/confirm/dissolve/invite
  claim, and the family one-step declare) keep their existing always-notify
  behaviour; the broader admin-email sweep is tracked separately as #1769b.

- **Admin book-on-behalf can overbook with an explicit confirmation (#1767).**
  A forward-dated on-behalf create that exceeds lodge capacity now follows the
  same warn-and-confirm contract as retroactive creates and admin date edits
  (#1668/#1695): full days stay selectable on the admin calendar, the guest
  step warns, and submitting prompts "Confirm over-capacity and create"
  (audited as `capacityOverridden`). An on-behalf create that opted into the
  waitlist fallback still waitlists instead of prompting. (#1771 persists and
  honours the override, so a priced overridden booking is no longer cancelled
  when payment lands over capacity, and the former non-member hold-eligible
  (PENDING) carve-out is retired.) The admin guest caps now follow the selected
  lodge's resolved capacity, and over-capacity parties cannot be saved as
  drafts. Member self-books are unchanged — members can never overbook.

- **Auto bed allocation no longer strands large groups (#1768).** The split
  fallback used to cap rooms-with-minors at the booking's adult count — a
  school group with two teachers filled exactly two rooms and reported the
  remaining students `NO_BED_AVAILABLE` with rooms empty. Minors now overflow
  into rooms of their own once the booking has an adult on-site that night
  (the Phase-0 night-level rule is unchanged), SCHOOL-request bookings room
  their teachers together and students separately, and a new hard invariant
  is enforced on every placement path in both directions: a room-night
  holding one booking's minors never also holds another booking's adult —
  displacement evicts a conflicting provisional booking whole or backs off,
  relocation falls back to unallocating rather than moving anyone beside a
  stranger, and persisted violations surface as a `MINOR_ADULT_MIX` board
  warning.

- **Admins can add a confirmed partner to a full lodge (#1746, completing the
  double-bed epic #1741).** The admin edit-booking panel now offers the
  confirmed partners of a booking's member guests as "partner (shares a
  double bed)" quick-adds; the added partner is admitted through the reserved
  partner-shared slots (#1745) even when the lodge is full by beds — bounded
  per night by the double count — and is then placed as the double's second
  occupant on the allocation board as before. Admin-only end to end: the
  `partnerSharedGuests` flags are rejected for non-admin callers at both the
  modify routes and the service, the public wizard is unchanged, and a
  rejected admission shows the capacity check's reason rather than the
  over-capacity overbook confirm.

- **Lodge capacity gains reserved partner-shared headroom (#1745, part of the
  double-bed epic #1741).** Each active shareable `DOUBLE` bed now contributes
  one admission slot **above** the base lodge capacity — reserved for a guest
  whose CONFIRMED partner (#1742/#1744) holds an ordinary place on the same
  nights, bounded by the double count per night, and never past an explicit
  per-lodge capacity (a fire/licence people-ceiling zeroes the headroom, so a
  capped lodge is unaffected). Public and member booking paths are untouched:
  the base figure they read is unchanged, and only the admin-initiated
  partner-shared admission check (`checkCapacityForPartnerSharedAdmission`;
  initiation surface lands with #1746) can use the extra slots. The admin
  lodge Capacity card breaks the figure out ("10 beds + up to 1 partner
  spot") rather than showing a combined number.

- Added the declared **Partner/Husband/Wife relationship** (#1742, part of the
  double-bed shared-occupancy epic #1741): a symmetric, consent-based
  `MemberPartnerLink` between two adult members with a request→confirm flow
  mirroring family invitations. Members declare a partner from the profile
  Partner card (the partner confirms or declines from their own profile); a
  family-group admin can declare a no-login adult member of their group in one
  step; admins can assign or remove a partnership directly from the member
  detail page (recorded as admin-assigned); and the family create-group form
  can mark the named partner so an unregistered partner's invite token (#1682)
  forms the link when claimed — the claim page discloses the partnership
  before the invitee accepts. Invariants: at most one confirmed partner per
  member (advisory-locked, with DB partial-unique backstops), adults only, no
  self-partnering; removed/declined links are hard-deleted with full audit
  history, and the affected partner is emailed on removal. New emails:
  `partner-link-request`, `partner-link-confirmed`, `partner-link-removed`.
  Expand-only migration (`MemberPartnerLink` table +
  `PartnerInviteToken.createPartnerLink`). This link is the eligibility signal
  the bed-share children consume: double-bed placement eligibility (#1744)
  and the partner-shared capacity headroom (#1745) both read it via
  `mayShareDoubleBed`. A by-email partner request always answers with the generic
  "If they're eligible, we've sent them a partner request." so a member cannot
  probe whether someone already has a confirmed partner (D9 owner decision);
  and the inviter of an unregistered declared partner can cancel their own
  outstanding invitation from the profile Partner card before it is claimed
  (#1754).

- **Behaviour change — lodge capacity now honours a max-sleeping-capacity
  ceiling (#1653).** A per-lodge `LodgeSettings.capacity` value now caps the bed
  count when Bed Allocation is on: effective capacity is the lower of the
  installed active beds and the capacity, so a lodge may have more beds than it
  is allowed to sleep. Previously the capacity was *ignored* whenever beds were
  configured. **Operator action:** if a lodge has both configured beds **and** a
  capacity set *below* its bed count, its bookable capacity will drop to that
  value on upgrade. Run the read-only detection query in
  `docs/CAPACITY_MODEL.md` to list any affected lodge and confirm the cap is
  intended before deploying. No schema migration; code-only. See
  `docs/CAPACITY_MODEL.md` for the full resolution table.
- Promoted the two-lodge `E2E multi-lodge` CI job from advisory to a blocking
  required status check (#1655; launched advisory in #1623 for #1568, its one
  observed flake class root-caused and fixed test-side in #1650). Cross-lodge
  E2E regressions now block merges the same way the single-lodge Playwright
  suite does. CI-only; no application behaviour change.
- Added **Configuration Export & Import** (config transfer): a full-admin tool
  (Admin → Setup & Configuration → Export & Import) to export a club's
  configuration, site content, and lodge setup as a portable, database-id-free
  `.zip` bundle and import it into another (or the same) instance through a
  mandatory dry-run → confirm flow. Import is upsert-only (never deletes), takes
  a `pg_dump` backup before applying, runs under a single-flight advisory lock,
  and is audited. Categories: site content (pages/site-content/theme, with
  embedded-image bundling + reference remap), club settings singletons, lodge
  configuration (each lodge a self-contained `lodge-config/lodges/<slug>/`
  folder — `lodge.json` + rooms/beds/seasons/rates/instructions/chore-template
  CSVs, lodge implied by folder), committee **role definitions** (the legacy
  standalone member directory and member-linked assignments are excluded),
  induction checklist templates, and Xero account/item-code mappings (source
  org id in a sealed `xero-config/source.json`). Bundles are hand-editable:
  manifest checksums/row counts are advisory (mismatches warn in the dry-run,
  never block; import is files-first), with a "reseal" action to regenerate the
  manifest; only structural/safety problems are hard-refused (resource caps are
  enforced before inflation). Import has a per-run **write mode** (default
  **merge**): merge writes only fields that carry a value in the bundle
  (blank/omitted fields keep the record's existing value, so a partial or
  skeleton bundle patches rather than wipes); overwrite makes the bundle fully
  define each record (blanks clear). The **dry-run is mode-aware** and
  **strictly validates every row** — malformed dates/enums/money are errors
  (named by file, row, and field) that block apply until the bundle is fixed.
  The dry-run also offers a **match picker** for renamed seasons, chore
  templates, and induction templates, **per-category selection at import**, and
  prominently names any lodge whose door code would change. The plan
  fingerprint binds the bundle bytes, mode, selection, and resolutions, and is
  re-verified inside the apply transaction under the advisory lock — what was
  previewed is exactly what is applied. Success AND refused applies are
  audited (with bundle sha256, a bounded per-item diff, and the lodges whose
  door codes were actually written). Lodge folders carry the `isDefault`
  default-lodge marker (adopted from fork #15), applied via a safe
  clear-then-set. Never carries secrets, members, transactional data, or (by
  default) door codes. Not a
  database backup; the `pg_dump` subsystem remains the disaster-recovery tool.
  No schema migration. See `docs/config-transfer/`.

## 0.10.1 - 2026-07-07

- Release classification: patch public reference release. Four
  payment/booking-recovery hardening changes and one operator cleanup script on
  top of `0.10.0`; no database migrations, no schema changes, no new features,
  and no behaviour changes outside the raced/edge shapes described below. Safe
  to deploy tag-to-tag from `v0.10.0` with the standard backup-first procedure
  (`docs/UPGRADING.md`).
- Guarded the booking-request quote re-send status flip against a concurrent
  decline: the flip to `QUOTE_SENT` is now a claim-first, status-guarded update
  placed first in the existing transaction, so a re-send racing a decline can
  no longer resurrect a `DECLINED`/`CANCELLED` request or send its quote
  email — the losing re-send rolls back with a 409 (#1504).
- Converged the refund-request and booking-modification recovery replays with
  their inline Stripe refund bodies via shared per-path body builders. The
  replays previously sent a different `reason` under the same idempotency key,
  so Stripe rejected the replay with `idempotency_error` and the recovery
  retried to exhaustion instead of converging (safe-failing — never a double
  refund); replays now send byte-identical bodies and converge (#1507).
- Froze the refund-appeal Stripe allocation plan: the approve route computes
  the per-transaction refund allocation once, uses it for the inline refund,
  and on inline failure persists those same slices to the recovery operation,
  so the replay re-requests exactly the original slices under the original
  idempotency keys. This supersedes the previous completed-refund remainder
  heuristic and closes the last refund-recovery path that re-derived its
  allocation at replay time. In the exotic mixed Stripe + Internet-Banking
  appeal shape, the route now refunds the plannable Stripe portion inline and
  logs any shortfall instead of pushing the mismatch into recovery — net
  Stripe money is unchanged and the Internet-Banking portion still settles via
  credit note (#1510).
- Capped the never-settled Internet-Banking credit mint per invoice in
  aggregate: multiple never-settled IB payments matched to a single invoice can
  no longer collectively mint account credit above that invoice's cash. The
  previous clamp was per-payment; no current app flow produces the aggregate
  shape, so real-flow mint amounts are unchanged (#1505).
- Added `npm run payments:backfill-cancel-flattened`, a one-off, idempotent,
  dry-run-by-default operator script that restores the stored `Payment.status`
  on rows the pre-#1489 cancel defect flattened to `FAILED` on cancelled
  bookings (the read path already synthesizes the correct captured status from
  the intact ledger/mirror). It makes no Xero and no Stripe calls and is
  documented in `docs/MAINTENANCE.md` (#1506).
- Migration/deployment notes: **this release contains no database migrations**
  and requires no post-upgrade actions; `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`
  gains no rows and either app color can serve throughout the deploy. Optional
  cleanup: forks that ever ran a pre-`v0.10.0` (pre-#1489) build can restore
  cancel-flattened stored payment statuses with the #1506 backfill above —
  dry-run first, per `docs/MAINTENANCE.md`.

## 0.10.0 - 2026-07-07

- Release classification: minor public reference release. The change set since
  `0.9.0` is a large quality-and-hardening wave layered on top of new public
  booking, membership, and finance capabilities, followed by a remediation wave
  (epic #1348) that closed the post-wave audit findings and a live-feedback
  admin-UX wave (epic #1438), all preserving the existing public deployment
  shape. Highlights below; individual behavior changes are called out inline.
  Forks upgrading from `0.9.0` must read `docs/UPGRADING.md` and the
  Migration/deployment notes at the end of this section before deploying: this
  release includes two destructive/behaviour migrations (module defaults switch
  off, in-flight induction results cleared) and other hot-table migrations.
- Ran a best-in-class quality wave (epic #1125): dead-code sweeps and a bundle
  audit, large file splits for the booking wizard, booking create/modify,
  member detail, and email modules, native UI primitives (confirm/prompt
  dialogs, loading skeletons) replacing browser `alert`/`confirm`, an
  observability and cron-health parity pass, database query-performance work, a
  consolidated settlement-math path, a Xero architecture review, and an
  access-role/authorization matrix cleanup. New automated test layers landed as
  part of the wave: a Playwright end-to-end foundation with Critical/High test
  matrix coverage, an authorization-matrix route test, property-based tests for
  pricing/settlement invariants, and a typecheck gate that now also covers test
  files. Notable decision: colour contrast on the configurable site-style
  palette is now enforced (blocking, server-side, for both hex and `oklch`)
  rather than left advisory.
- Added a public booking quote system with a member-facing quote workflow,
  quote TTL and reminder emails, quote/booking reprice paths, night-price
  locking, and waitlist-offer repricing.
- Hardened payment, refund, and settlement recovery: refund recovery
  allocation, refund revert recovery, credit-note delta handling, refund prefix
  reuse, a settlement reaper for stale intents with reaped-children expiry,
  durable payment-intent retry, group-settlement superseded/stale-total fixes,
  and queuing the Xero invoice after card payment.
- Expanded membership and family lifecycle: seasonal membership types with a
  membership-type editor, enforcement, and name guards; a member removal
  lifecycle with collection handling; committee assignments with contact
  privacy and committee email; member-import identity contract, address UX, and
  audit rollback; school attendee confirmation with resendable links and
  non-member school role types; hut-leader eligibility and look-ahead; and an
  induction redesign.
- Added two-factor authentication (TOTP) with server-side verification, and
  hardened security boundaries: webhook hardening, a privileged-email gate,
  shared and degraded-mode rate limiting, token URL-scheme tightening, a backup
  fire-drill, and a migration audit.
- Reworked public site and content management: a structured public-content
  editor with a publish/hide toggle, CMS policy pages, site banners and footer
  content, an FAQ accordion, help screens, public safety-UX parity, an
  address-autocomplete module, and analytics-consent handling.
- Improved admin and member UX: an admin dashboard and sidebar refresh, booking
  filters, a bed-allocation board, member-night conflict surfacing, minors-only
  booking review, approval person-night handling, loading skeletons, and
  clearer feedback conventions.
- Deepened accessibility: a staging accessibility pass with axe findings fixes,
  booking-calendar keyboard/screen-reader labelling, and a booking-wizard and
  admin-members deep pass that also enforces the site-style colour contrast
  described above (epic #1125).
- Extended Xero and finance surfaces: a Xero architecture review, granular Xero
  report scopes, a finance report account-mappings UI, finance surfacing, and
  unpaid-invoice reduction.
- Refreshed dependencies with minor/patch updates and dependency triage.
- Added editable admin access roles. The six seeded bundles (Read-only Admin,
  Booking Officer, Membership Officer, Content Manager, Finance Viewer,
  Treasurer) are now database-backed definitions that a Full Admin can rename,
  re-permission, or delete at `/admin/access-roles`, and brand-new custom
  roles can be created with their own per-area permission matrix. Full Admin,
  Lodge, User, and Organisation remain protected system roles. Custom roles
  fall under the existing Full-Admin separation-of-duties gate, definition
  deletion is blocked while members hold the role, and all definition changes
  write critical-severity audit entries.
- Behavior change: finance-portal access now derives from the merged finance
  area level of the admin permission matrix instead of the two finance enum
  roles. Full Admin is now a finance manager in `/finance`; Read-only Admin,
  Booking Officer, and Membership Officer (finance view in their seeded
  matrices) can open the finance portal read-only and see the Finance nav
  link; Finance Viewer additionally gains read-only access to the finance
  admin area pages (for example `/admin/payments`).
- Renamed the `ADMIN_BOOKINGS` access-role display label from "Booking
  Office" to "Booking Officer" (display copy only; the stored enum value is
  unchanged).
- Ran a second hardening wave (epic #1204) that closed out every wave-1
  residual surfaced by the quality-epic audits. Grouped highlights below.
- Money and booking correctness: made booking cancellation single-flight
  (#1160) and booking-request quote acceptance idempotent so a retry or timeout
  can no longer double-book, double-charge, or double-invoice (#1232); extended
  the person-night conflict guard to the date-change flow
  (#1157) and to booking-request approval, quote-hold, and school-request
  approval (#1158), and froze the advisory-lock-before-guard ordering for every
  member-linked guest-night writer by test (#1159); fixed Xero invoice-line
  rounding drift (#1163); hardened group settlement/cancel and the cancellation
  tier boundary (#1165, #1166); added a defensive promo-cap allocation assertion
  (#1206); added layered money-path idempotency defenses — atomic
  credit-allocation repair under the booking advisory lock and a
  supplementary-invoice idempotency-key guard, with the Xero outbox dedup kept
  status-based by design (#1234); made group-cancel refunds resumable via
  a persisted refund plan and reaper (#1236); and de-duplicated stale
  payment-recovery alerts with a claim-first cooldown (#1211). Behavior/policy
  change: credit-paid bookings now follow the same cancellation-penalty tiers as
  card-paid bookings (#1164); the cancellation help text and email copy shipped
  with it and the committee was flagged for a heads-up.
- Xero and books integrity: a second refund on a payment now always receives a
  refund credit note, with a health check (#1162); the late inbound
  capacity-fail credit note is now enqueued inside the reconcile transaction so a
  crash can no longer leave a local credit with no Xero mirror (#1233); the
  reconciliation report surfaces failing inbound events (#1196); the money-path
  invariant audit was
  extended to the previously-unaudited surfaces (#1205); and the Xero subsystem
  was split into cohesive modules behaviour-identically (#1208).
- Platform, security, and hygiene: next-auth dependency hygiene (dropped a dead
  adapter and narrowed an override) (#1182); fixed the React Compiler lint
  findings (#1175); cut the admin client zod bundle (#1197); root-caused and
  fixed the login-page hydration double-render behind the flaky 2FA E2E spec
  (#1207); added a scoped `pino → Sentry` bridge for the cron and webhook
  loggers (#1214); made the Stripe payment E2E robust to Stripe's inline-vs-
  redirect confirmation path (#1220); and stopped raw Stripe initialization
  errors (which could carry partial key material) from reaching members on the
  pay step — generic copy is shown and the detail goes only to scrubbed Sentry
  telemetry (#1223).
- Maintainability: extracted the `/book` wizard state machine into a hook
  (#1209); split the admin-alerts email module (#1210); made admin bookings sort
  by lifecycle status (#1215); and triaged the 197 used-only-by-tests exports,
  annotating each as an intentional test seam (#1216).
- Accessibility, UX, and copy: exempted the single-action nomination
  confirmation flow from the mandatory profile-completion gate (#1221); fixed
  the duplicated "Postal Postal Code" address labels and aligned them to
  "Postcode" (#1222); added the remaining page `h1`s and fixed the website-footer
  heading order, then verified the booking-wizard and admin-members keyboard
  accessibility live (#1242, #1295); and noted on the site-style setup screen
  that the public site — including the membership application form — stays hidden
  until saved (#1245); and aligned transactional email theming with the
  configured site theme (#1186). Config: a one-time idempotent data migration
  bumps any
  persisted site-style theme still on the old sub-AA default gold `#7a8f6a` to
  the AA-compliant `#8fa87c` so those installs can save again (#1244).
- Verification and docs: refreshed `DOMAIN_INVARIANTS.md` and
  `SECURITY-ATTACK-SURFACE.md` to the true wave-2 end state and re-ran the
  concurrency audit (#1212, #1159).
- Recorded as deliberately-unchanged, owner-ratified wave-1 trade-offs
  (decision-menu rows D1, D2, D3, D5, D8, D9b): the CSP `style-src
  'unsafe-inline'` and broad `img-src https:` breadth; `getClientIp` trusting
  `x-real-ip` under the "Caddy always fronts" deployment invariant; deferring a
  finer split of `booking-modify-plan.ts` until after #1159; and holding the
  Node 26 LTS + `@types/node` 26 upgrade for its own maintenance window (#1176).
- Completed the configurable site-style dark-mode contrast work started in the
  quality wave: fixed colored-opacity tokens that failed contrast in dark mode
  (#1307) and the `red-500` dark-mode contrast on destructive controls (#1310).
- Behaviour change — Booking Officer and on-behalf booking authorization scope:
  the member-detail admin route and booking-detail viewer now gate on
  area-level admin access (`hasAdminAreaAccess`/`canViewAsAdmin`) instead of
  Full-Admin-only, so Booking Officers regain the booking views their seeded
  matrix grants (#1325, #1343); admin and member payment controls were separated
  on the booking-detail surface (#1326); the member booking and quote APIs were
  widened so `bookings:edit` holders can create and quote on behalf of members,
  with the caller's own bookings still routed through normal member payment
  paths and a quote that refuses to silently price the caller when `forMemberId`
  is supplied (#1345, with the dual-hat booking follow-up #1467); custom
  access-role definitions now flow through the session (#1388) and view-role
  admins get the correct read-only controls (#1394).
- Behaviour change — email preference enforcement: transactional preference
  checks (`shouldSendEmail`) are now wired into the cron check-in reminders and
  the chores email paths so member opt-outs are honoured, and the
  chore/roster dependent-preference handling was aligned (#1328, #1344).
- Behaviour change — non-member hold policy: added the admin toggle governing
  whether public/non-member bookings may hold capacity, with the matching
  stale-copy nudge and copy updates (#1329, #1337).
- Booking-request and approval flows: mapped approval contacts correctly when
  converting requests into bookings (#1304); surfaced a confirm-guests success
  toast (#1312); and made the decline flow record its "quote sent" transition
  cleanly (#1434).
- Bed allocation: reworked the allocation-board UX (#1324), added
  capacity-holding priority so a booking that needs a bed deprioritises
  provisional occupants (#1410), hid the manual-hold control where it did not
  apply (#1405), and gated the bed-allocation board behind its Admin Module
  toggle (#1454); added the link-time conflict advisory and its on-load
  sequencing (#1332, #1340).
- Quote and hold lifecycle: corrected the lapsed-hold banner copy (#1331),
  documented the quote-hold semantics (#1338), and released the hold on a
  declined booking request (#1421).
- Xero and books integrity: split the Xero inbound-reconciliation module into
  cohesive units behaviour-identically (#1330); ran a Xero invoice-line rounding
  audit (#1341); added a persisted `queueType` column to the Xero operation
  outbox, switched the outbox scan to it, and extracted a shared claim helper
  (#1347, #1380, #1381); floored the inbound-repair ledger so a repair cannot
  drive a balance negative (#1408); built a refund-delta pipeline for
  modification refunds (#1414); rejected stale cached Xero refresh tokens
  instead of looping on them (#1416); moved Xero writes out of the booking
  transaction (#1420); handled mixed-sign booking edits (#1428); closed a
  missing refund-credit-note gap (#1477); and hardened mixed cash-plus-credit
  settlement minting (#1486).
- Cancellation and refund money-path (remediation epic #1348): made the
  no-payment cancel claim-first with a fresh re-read under the advisory lock
  (#1334, #1339); closed a cancel-refund crash window with a frozen refund plan
  (#1384); recovered late captures on already-cancelled bookings (#1390); made
  group-settlement refunds retry durably (#1396); closed a cancel
  time-of-check/time-of-use race (#1426); made Internet-Banking hold-expiry
  durable (#1436); guarded the cancelled-booking uncollected path (#1437); sized
  operator repair credit notes correctly and made them manual-review (#1472);
  preserved payment status/refund history through a cancel instead of
  flattening it (#1489); converged the inline and recovery-cron Stripe refund
  request bodies so a frozen-plan cancel-refund replay after a lost recording
  converges at Stripe instead of retrying to exhaustion (#1499); and queued the
  Xero refund credit note for the completed slices when a forced late-capture
  repair refund partially fails (#1501). Behaviour/policy change (decision D7
  refinement): a
  booking cancelled with a captured-but-partially-refunded payment now takes the
  paid cancellation path and receives the policy tier of the remaining captured
  value, instead of forfeiting it until an operator repair run refunded it at
  100%; the repair pass's late-capture refund is now confirm-only and never
  auto-applied (#1493). The committee heads-up on the underlying tiered
  credit-restore cancellation policy is owed before wider rollout.
- Capacity, family, and booking hardening: reused capacity from school-held
  bookings correctly (#1398); confirmed capacity on the confirm-guests path
  (#1413); scoped family lookups on the bookings surface (#1415); blocked minor
  check-ins and followed up on the guard (#1417, #1424); cleaned up orphaned
  family links (#1425); and made confirm-guests recovery resumable (#1432).
- Admin member-detail and members-list UX (live-feedback epic #1438): a
  multi-part member-detail refresh (header, grouped sections, inline edit, and a
  final polish pass) (#1429, #1430, #1431, #1433); a derived User Type dropdown
  with progressive Access Roles disclosure and an "Also a club member" toggle
  (#1460); a single Access column showing the login-journey stage (#1488); a
  real Membership Type filter and a combined "Type – Tier" column (#1490);
  in-dialog bulk-invite errors and progress with the 10-minute cooldown removed
  (#1470); surfaced zod field-validation errors on the member edit/create paths
  (#1461); a global "permanently hide" for family suggestions with a master
  reset (#1466); a shared admin occupancy calendar adopted by Hut Leaders and
  Roster (#1463); a full sidebar restructure into Setup & Configuration hubs
  with Chores moved (#1457); and a Membership Types page redesign (#1464).
- Membership lifecycle — AgeTier N/A (epic #1438): added a `NOT_APPLICABLE`
  age tier for organisation-type members via a two-step enum + backfill
  migration, with server-forced N/A for organisations (422 for people), a
  DOB-derived restore on reclassification, and audits of the age-up cron, Xero
  age-tier groups, and subscription paths to skip N/A (#1484); organisations are
  now exempt from entrance fees (#1492). See the Migration/deployment notes
  below for the quiet-window/deferral deploy plan.
- Xero admin surfaces (epic #1438): the mismatch panels' Refresh now resyncs the
  listed contacts from Xero (targeted, batched, budget-metered) (#1487); a
  contextual "groups last refreshed" hint replaced the persistent banner
  (#1481); and Xero operation payloads gained plain-English request/response
  summaries with a raw-JSON toggle (#1456).
- Finance dashboard rework and hardening: rebuilt the finance dashboard on a
  monthly-facts dataset (#1455), cut over to the reworked dashboard (#1474),
  swept finance number formatting (#1482), added finance-sync health signals
  (#1485), moved the admin payment windows onto the club timezone (#1496), and
  fixed six verified minors from the monthly-facts adversarial review — loud
  partial-parse/partial-resolution sync failures instead of silent data loss,
  bounded backfills that walk through dormant years, and dashboard consistency
  fixes (#1500).
- Settlement and payments: gated settlement behind a cash check (#1458).
- Platform, security, and operations hardening (remediation epic #1348):
  recorded the blue/green migration-safety ledger entry whose absence had
  hard-blocked a fork upgrade from `v0.9.0` (#1382); guarded the demo seed from
  running against real data (#1383); refreshed the deployment docs (#1391);
  surfaced account-deletion state (#1399); documented the custodian workaround
  (#1401); added backup-health signals (#1403); tightened the agent
  guardrails/docs (#1404); fixed a paid-status name typo (#1409); added
  dashboard deep-links (#1395); fixed the `www` canonical redirect (#1412);
  root-caused and fixed a streamed duplicate-mount that broke post-reload
  assertions (#1462); ran a member-UX pass with unpaid-refund copy and
  hard-reload race fixes (#1389, #1392, #1397); polished the hut-leader label
  and fixed its CMS token (#1335, #1342); lazy-loaded the site-style zod bundle
  (#1323); and documented `AUTH_SECRET` rotation plus an owner subscription
  alert (#1465, #1476).
- Planning and research (owner-ratified as research-only, no runtime change):
  recorded the Node 26 LTS upgrade plan (#1497) and the better-auth evaluation
  (#1498).
- Added the fork-facing production upgrade runbook
  (`docs/PRODUCTION_UPGRADE_RUNBOOK.md`) for the v0.9.0-era → v0.10.0 window:
  pre-flight backup and prediction queries, blue/green migrate with the AgeTier
  quiet-window plan, post-upgrade checklist, rollback, and rehearsal/execution
  records (#1502).
- Testing, CI, and release hygiene: added end-to-end coverage for the
  bed-allocation module gate (#1314), route-map drift tests (#1333), email/2FA
  E2E coverage (#1336), made Playwright E2E blocking in CI (#1346), added E2E
  matrix concurrency handling and new journey specs (#1393, #1453), deflaked the
  Internet-Banking E2E (#1407), and landed the Wave-4 independent-review
  regression fixes (#1480).
- Refreshed dependencies with a minor/patch update batch (#1309).
- Migration/deployment notes (read `docs/UPGRADING.md` first; always back up the
  database before migrating):
  - `20260627120000_core_module_defaults_off` switches the high-risk capability
    modules — kiosk, chores, finance dashboard, waitlist, Xero integration, bed
    allocation, and Internet Banking payments — to default `false` and repairs
    only the untouched singleton `ClubModuleSettings` default row (where
    `updatedByMemberId IS NULL`). Any fork whose Module settings were never
    admin-saved will see these features switch OFF on upgrade; re-enable them in
    Admin > Modules after provider/setup readiness. Rows an admin has saved are
    preserved, and general-purpose modules stay default-on.
  - `20260702100000_induction_workflow_types` adds the `HUT_LEADER` induction
    kind and per-kind template activation, and **clears in-flight
    (`DRAFT`/`IN_PROGRESS`) self-assessment and per-item induction result state**
    that the new single-Pass flow no longer uses; completed historical rows are
    preserved. Complete or export any in-flight inductions before upgrading.
  - `20260630120000_rename_member_role_to_user` (contract) collapses the legacy
    `Member.role` `MEMBER`/`ASSOCIATE`/`LIFE` values into `USER` and recreates
    the `Role` enum. It assumes no live deployment used the intermediate
    Access-Roles window; forks that deployed intermediate `main` between
    2026-06-28 and 2026-06-30 should run `npm run db:audit-access-role-cleanup`
    after upgrading.
  - `20260707000000_add_age_tier_not_applicable` and
    `20260707000100_backfill_org_age_tier_not_applicable` add the
    `NOT_APPLICABLE` age tier and flip ADULT organisation-type members to it.
    Pre-#1440 app colors cannot deserialize `NOT_APPLICABLE`, so old-color reads
    of the flipped rows (admin members list, that member's detail, school flows)
    can error between migrate and cutover. Per the owner decision on epic #1438
    (2026-07-07), deploy both migrations in a **quiet window** and cut over
    promptly, or **defer** the backfill migration until the old color drains
    (the UPDATE is idempotent and safe to run late). See
    `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and `docs/UPGRADING.md`.
  - Verified blue/green-safe, no re-audit needed: the `ClubTheme` sub-AA gold
    theme bump is conditional on the persisted value (#1244), the
    `BookingGuestNight` backfill is automatic and old-code-compatible, and the
    access-role backfills keep old code reading
    `Member.role`/`financeAccessLevel` unchanged. All are recorded in
    `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.

## 0.9.0 - 2026-06-27

- Release classification: minor public reference release. The change set since
  `0.8.0` adds public join flows, module controls, induction, locker,
  finance-dashboard, provider-recovery, and security hardening while preserving
  the existing public deployment shape.
- Added group-booking join flows and APIs, including organiser-owned join
  codes, member self-add, non-member email verification, organiser management,
  organiser cancellation cleanup, public join pages, member dashboard context,
  and protected route/API coverage for group joinability.
- Added group-booking settlement options for both each-pays-own and
  organiser-pays modes. Organisers can collect one combined Stripe payment or
  one Internet Banking/Xero invoice for joined bookings, while joiners remain
  linked to their own child bookings for capacity, status, and audit purposes.
- Added lodge induction and sign-off workflows with induction templates,
  section/item results, assigned signers, self-assessment capture, member
  sign-off records, route access hardening, and nomination settings support for
  deployments that require induction before membership completion.
- Added member locker administration and allocation, including API validation,
  unique locker names, dashboard/member context, and admin controls that can be
  disabled through Admin Modules.
- Added database-backed Admin Modules toggles for group bookings, lockers,
  induction, work parties, promo codes, hut leaders, communications, and
  skifield conditions, keeping deploy-time `.env` capabilities as the outer
  operator gate.
- Added member category and profile metadata support, including Life and
  Associate member categories, title, gender, occupation, life-member date,
  comments, configurable member-field visibility, CSV import/export hardening,
  and refreshed member edit/detail screens.
- Added subscription booking lockout controls so clubs can block bookings for
  members with unpaid annual subscriptions, configure the lockout behavior in
  admin, and align the subscription year with either Xero's financial year or
  an explicit local override.
- Reworked the finance dashboard to use the single operational Xero connection
  already used by bookings, payments, and subscriptions. Finance-specific Xero
  OAuth routes, token storage, and finance Xero usage metering were removed,
  while finance reports gained revenue reconciliation, chart-of-accounts
  snapshots, KPI cards, trend/mix charts, balance-sheet, cash, costs, working
  capital, pricing-sensitivity, and booking metric views.
- Added Whakapapa/skifield condition widgets and admin cache controls with
  cached report payloads, freeze windows, public endpoint handling, and module
  gating for deployments that do not expose mountain-condition content.
- Fixed image upload/runtime storage and visual-editor behavior, including
  read-only root filesystem upload handling, image resizing, admin toolbar and
  alignment tests, photo-gallery token rendering, and safer upload trace
  redaction.
- Improved email/provider recovery visibility with token-email recovery
  actions, undeliverable admin-alert escalation, waitlist-offer email failure
  surfacing, Xero amount-mismatch repair alerts, missing Xero refund credit-note
  reporting, stale Xero operation/inbound-event recovery, exhausted payment
  recovery health signals, and the consolidated operator queue.
- Hardened security and idempotency boundaries, including source-scoped
  processed webhook event claims, SES SNS SignatureVersion 2 enforcement,
  Xero token refresh leases, payment-link/client-secret ownership tests,
  group-join response neutralisation, mixed-method route boundary coverage,
  public rate-limit proxy assumptions, and high-severity dependency refreshes.
- Migration/deployment notes:
  - `20260615110000_add_lodge_induction_signoff` creates induction template,
    result, signer, and settings tables plus `Member.requiresInduction`; run
    during low membership-admin traffic before enabling induction-gated flows.
  - `20260616120000_induction_assigned_signers_and_self_assessment` adds
    induction self-assessment fields and assigned-signer records; avoid active
    induction edits during cutover.
  - `20260618120000_add_group_booking` adds group-booking and join staging
    tables for shareable join codes; open new group joins only after the new
    runtime is live.
  - `20260619120000_add_booking_organiser_settled` adds
    `Booking.organiserSettled` for organiser-pays child bookings; run during
    low booking traffic and do not create organiser-pays joins until old app
    colors have drained.
  - `20260619130000_add_group_booking_settlement` and
    `20260620120000_add_group_settlement_internet_banking` add combined group
    settlement records for Stripe and Internet Banking/Xero settlement.
  - `20260620121500_add_whakapapa_report_cache` and
    `20260620133000_add_whakapapa_cache_frozen_until` add cached skifield
    report payloads and freeze-window controls.
  - `20260620145000_add_lockers` and `20260622100000_harden_locker_names` add
    member locker allocation and then enforce unique, bounded locker names;
    resolve duplicate locker names before the hardening migration.
  - `20260621150000_scope_processed_webhook_event_idempotency` replaces the
    global webhook-event idempotency key with a `(source, eventId)` key so
    Stripe, Xero, and SES events cannot collide across providers.
  - `20260621160000_add_xero_token_refresh_lease` adds the operational Xero
    token refresh lease used to prevent parallel refresh-token rotation.
  - `20260622120000_add_module_toggles` adds Admin Modules activation booleans
    for the newly modularised features, all defaulting on for upgraded installs.
  - `20260623120000_add_member_status_fields`,
    `20260623130000_add_member_gender_title`, and
    `20260626120000_member_field_visibility_and_categories` add the new member
    metadata/category fields and settings; avoid assigning new enum categories
    until the new runtime is serving traffic.
  - `20260626120000_add_membership_lockout_settings` adds the singleton
    subscription booking-lockout settings row used by admin controls.
  - `20260626120000_add_chart_of_accounts_finance_snapshot_type` adds the
    finance chart-of-accounts snapshot type used by revenue reconciliation.
  - `20260626121000_drop_finance_xero_storage_and_usage` drops the retired
    finance-specific Xero token and usage tables after the runtime has moved to
    the single operational Xero connection.

## 0.8.0 - 2026-06-15

- Release classification: minor public reference release. The change set since
  `0.7.0` adds major booking, content-management, public-request, lodge
  operations, and payment-link capabilities without an intentional public API or
  deployment-contract break that would justify `1.0.0`.
- Added admin-managed public website content, replacing hard-coded public pages
  with database-backed `PageContent` records, dynamic website routing, rich
  HTML editing, starter page backfills for deploy-only environments, and a
  first-class 404 content row.
- Added the page-content editor and image-picker workflow so admins can manage
  home, about, join, rules, contact, committee, membership-application, and 404
  content from the admin app while keeping special blocks such as member
  applications, contact forms, and committee cards available in managed pages.
- Added database-backed image management with upload APIs, public image
  delivery, image-library admin views, deletion coverage, metadata, alt text,
  and persistent storage that survives Docker redeploys instead of relying on
  ephemeral container filesystem paths.
- Added the site style wizard and theme storage with editable brand colours,
  heading/body font choices, logo data, raw CSS support, and seeded defaults
  that preserve an existing deployment's completed theme while giving new
  adopters generic starter branding.
- Added public non-member booking requests, including quote discovery, email
  verification tokens, admin review/pricing/approval/decline flows, conversion
  into bookings, admin notifications, and public payment links that do not
  require a member login.
- Added school group booking requests with school-name capture, teacher
  snapshots, school-specific public request routes, admin review support, and
  conversion paths that can create the required booking/member records for
  supervised school stays.
- Added secure public payment-link pages with token-hash storage, expiry,
  refresh and PaymentIntent creation routes, booking/payment narrative display,
  and shared member/non-member booking status copy.
- Changed booking capacity rules so only paid or confirmed bookings hold
  capacity, members pay up front, and provisional non-member records can expire
  cleanly without holding beds indefinitely.
- Added linked mixed-party booking handling: mixed member/non-member stays can
  split into a paid member parent booking plus a provisional non-member child
  booking, keeping member capacity and payment state separate from guests who
  still need to confirm or pay.
- Added cron-driven provisional non-member hold expiry with booking events,
  parent/child booking handling, payment-link revocation, and visible admin
  narratives when holds expire.
- Added durable `BookingEvent` records and a shared booking/payment-link
  narrative layer so created, paid, confirmed, bumped, cancelled, refunded, and
  credited events survive audit-log pruning and show consistently across
  booking and payment-link views.
- Added multi-date-range stays with a per-guest night grid, persisted
  `BookingGuestNight` rows, per-night integer-cent pricing, non-contiguous
  night support, booking creation/editing support, quote validation, Xero
  invoice line grouping, bed allocation support, and reporting compatibility.
- Added default partial-bump handling for capacity-constrained member bookings:
  members can keep their own paid stay while non-member guests are dropped and
  repriced unless the new "only book if my guests can come" flag asks for the
  whole booking to be cancelled.
- Added admin override and follow-up actions for pending guests, including
  confirm-pending-guests routes, UI controls, tests, and payment/narrative
  updates for the revised capacity model.
- Added preferred room requests at booking time, admin editing for requested
  rooms, route coverage, and auto-allocation support so the bed allocator tries
  the requested room before falling back to family-aware first-fit allocation.
- Reworked bed allocation into a drag-and-drop board with per-night guest
  chips, bucket views, room/bed tables, allocation chips, requested-room badges,
  and support for the new per-guest night model.
- Moved rooms and beds into admin configuration with import-from-config support
  so lodge inventory is managed through the app instead of requiring source-code
  changes.
- Added work party/working bee events with date ranges, admin CRUD, internal
  auto-applied promo codes, active public work-party discovery, CodeQL-safe code
  generation, and promo validation for volunteer discount stays.
- Expanded promo scope handling with assigned-member own-night restrictions,
  per-guest redemption targets, configurable fixed-nightly group promo pricing,
  hidden internal promo codes for work parties, and stronger promo route tests.
- Added protected lodge instructions for hut leaders, including open, close, and
  day-to-day documents stored separately from public page content, admin editing
  APIs, hut-leader/authenticated views, and kiosk display support.
- Added rolling door-code pre-arrival reminders with email-template support,
  per-booking sent timestamps, cron coverage, and subject-line hardening so
  sensitive door codes cannot be exposed in email subjects.
- Genericised seed data and first-run defaults for public adopters, including
  starter page content, account/default subscription rows, explicit member
  import no-op results, and setup/subscription handling when Xero is disabled.
- Hardened admin API boundaries with consolidated `requireAdmin` guard usage,
  query validation coverage, removed brittle exact API route counts, safer
  Prisma migration whitespace handling, and more focused tests for changed
  routes.
- Fixed admin daily revenue reports dropping the final day across DST and
  continued the release-wide NZ date-only hardening so booking/report dates do
  not drift through browser-local or timezone-sensitive parsing.
- Fixed migration drift by adding a follow-up migration that drops DB-level
  defaults from `@updatedAt` columns now managed by Prisma Client.
- Updated dependency and security posture with an npm minor/patch dependency
  refresh, an `esbuild` advisory fix, and release-follow-up changes for GitHub
  Actions/static-analysis failures.
- Migration/deployment notes:
  - `20260607171000_add_promo_assignment_scope` adds
    `PromoCode.assignedMembersOnlyOwnNights` with a default of `true`; deploy
    during low promo-booking traffic and review assigned-member promo behaviour
    before enabling new scoped promotions.
  - `20260608103000_add_promo_redemption_guest_targets` creates
    `PromoRedemptionGuestTarget` so redemptions can be tied to individual guest
    nights; deploy before using own-night promo enforcement.
  - `20260611100000_add_page_content`,
    `20260611101500_backfill_starter_page_content`, and
    `20260614110000_backfill_404_page_content` add and seed database-backed
    public pages for environments that run migrations without the seed.
  - `20260611120000_add_door_code_pre_arrival_reminders` adds
    `Booking.preArrivalReminderSentAt`, `EmailMessageSetting.doorCode`, and a
    booking status/reminder/check-in index for the new cron reminder path.
  - `20260611123000_add_club_theme` and
    `20260614100000_add_club_theme_raw_css` add the singleton theme record,
    fonts, logo storage, colours, and raw CSS customisation used by the style
    wizard.
  - `20260611150000_add_lodge_instructions` creates the protected lodge
    instruction documents and backfills open, close, and day-to-day rows.
  - `20260612090000_add_booking_requested_room` adds a nullable
    `Booking.requestedRoomId` foreign key into lodge-room inventory; run during
    low booking traffic.
  - `20260612100000_add_work_party_events` adds hidden internal promo support
    and `WorkPartyEvent` records; create work-party events only after the new
    runtime is serving traffic.
  - `20260612110000_add_media_image` stores uploaded images in Postgres; verify
    database storage/backups are sized for image uploads before opening the
    admin image manager broadly.
  - `20260612120000_add_cancel_if_guests_bumped` adds the member opt-in
    whole-booking cancellation flag for capacity bump handling.
  - `20260612130000_add_booking_request_flow` creates booking request,
    payment-link, settings, verification, and notification structures used by
    the public non-member request flow.
  - `20260613090000_add_school_booking_request` adds the `SCHOOL` request type
    and school-specific request columns.
  - `20260613090000_update_starter_home_page_content` updates only untouched
    starter home-page copy; admin-edited rows are left unchanged.
  - `20260613100000_add_booking_group_link` adds
    `Booking.parentBookingId` for linked member/non-member bookings; run during
    low booking traffic and let the deploy guard stop on lock timeout.
  - `20260614090000_add_booking_guest_night` backfills one
    `BookingGuestNight` row per historical guest night and splits existing
    integer-cent guest totals exactly across nights. Run during low booking
    traffic, avoid booking/guest writes during migration and cutover, and
    verify every active guest has night rows before enabling multi-date ranges.
  - `20260614153000_add_booking_event` creates the durable booking event store;
    no historical event backfill is attempted, so narratives become complete
    from the first runtime write after deployment.
  - `20260615090000_drop_updatedat_column_defaults` reconciles database defaults
    with Prisma `@updatedAt` semantics for `BedAllocationSettings` and
    `ClubTheme`; it is intended to clear migration-drift checks without
    changing application behaviour.

## 0.7.0 - 2026-06-08

- Added room and bed allocation management with admin room/bed inventory,
  first-fit family-aware allocation planning, automatic lifecycle
  reconciliation for booking confirmation/edit/cancel/waitlist flows, manual
  allocation controls, approval tracking, and focused bed-allocation filters.
- Added per-guest booking date ranges to the live booking and modification
  flows, including capacity accounting, quote validation, waitlist, roster, and
  finance/reporting paths that count only each guest's actual stay nights.
- Added fixed-nightly-price promo codes with set-price and cap-only modes,
  integer-cent promo adjustment tracking, member/profile display, booking edit
  support, Xero invoice handling, and promo-admin validation.
- Added Internet Banking payment support backed by operational Xero invoices,
  first-class `PaymentSource` typing, payment option discovery, booking-detail
  invoice/reference display, and inbound Xero reconciliation for settlement
  instead of routing bank-transfer bookings through Stripe.
- Added booking reduction settlement choices so negative booking modifications
  can become either Stripe refund work or idempotent member account credits,
  with source-linked modification credits and Xero settlement payload coverage.
- Added the member CSV import wizard with column mapping, date-format handling,
  preview/failure reporting, skip counts, and hardened import validation.
- Added admin operational filters and drilldowns for booking payment source,
  Xero sync state, bed allocation state, per-guest ranges, change/refund state,
  payment settlement kind, Xero operations, and inbound Xero events.
- Hardened payment and accounting boundaries so Internet Banking bookings do
  not enter Stripe-only PaymentIntent, refund, or recovery paths and Xero
  invoice settlement is driven by the inbound reconciliation path.
- Hardened API and operational surfaces with centralized malformed-JSON
  responses on changed routes, cron/payment/Xero audit visibility, and a pinned
  Turbopack root for predictable Next.js 16 builds.
- Migration/deployment notes:
  - New optional module gates are `FEATURE_BED_ALLOCATION` and
    `FEATURE_INTERNET_BANKING_PAYMENTS`; Internet Banking also requires
    operational Xero capability, credentials, and tenant connection.
  - `20260607120000_add_bed_allocation_and_internet_banking_modules` adds the
    Admin Modules activation booleans for bed allocation and Internet Banking.
  - `20260607130000_add_fixed_nightly_promo_adjustments` adds fixed-nightly
    promo types and integer-cent adjustment columns on booking/promo redemption
    records; deploy during low promo-booking traffic.
  - `20260607133000_add_bed_allocation_inventory` and
    `20260607142000_add_bed_allocation_settings` add the room, bed, allocation,
    and settings tables used by admin bed allocation.
  - `20260607150000_add_payment_source_foundation` adds first-class Stripe vs
    Internet Banking payment source fields; do not enable Internet Banking
    payments for members until old app colors have drained.
  - `20260607164000_add_booking_modification_credit_source` and
    `20260607165000_make_booking_modification_credit_unique` add source-linked,
    idempotent member credits for booking reductions.

## 0.6.0 - 2026-06-03

- Added booking review and approval workflows, including `AWAITING_REVIEW`
  booking status handling, member justification capture, admin review APIs,
  approval queue views, and route coverage for review, modify, cancel,
  force-confirm, and report paths.
- Added child family request dependant creation, no-adult booking review
  handling, unpaid cancelled booking deletion, and clearer admin queue
  navigation for booking and family-group review work.
- Added promo-code finance improvements with per-promo-code Xero coding,
  split per-booking and lifetime free-night caps, partial discount support,
  and migration coverage for promo and review data changes.
- Hardened privileged, public, webhook, payment, Xero, runtime-status, cron,
  route-guard, and external-service boundaries with focused tests and security
  documentation.
- Updated CI and deployment hardening, including gitleaks v3, dependency review,
  static analysis, Docker image scanning, migration-safety documentation, and
  production image runtime dependency packaging.
- Refreshed minor and patch dependencies across the application stack, including
  Next.js, React, Sentry, Stripe, Nodemailer, Vitest, ESLint, and related lockfile
  entries, while retaining explicit security overrides for vulnerable transitive
  packages.

## 0.5.0 - 2026-05-28

- Added safe booking deletion with nullable booking soft-delete fields, admin
  visibility filtering, deletion audit coverage, and a migration safety ledger
  entry for the hot `Booking` table.
- Added the archive lifecycle review queue and admin/member lifecycle surfaces
  for governed archive handling.
- Fixed promo beneficiary cap accounting with per-member promo redemption
  allocations, allocation-aware redemption counts, and migration coverage for
  existing redemptions.
- Fixed placeholder subscription delete blockers so draft and placeholder guest
  subscriptions no longer block legitimate member cleanup paths.
- Folded the blue/green deploy engine into
  `scripts/run-production-blue-green-deploy.sh` and removed the old
  `scripts/blue-green-deploy.sh` entrypoint.
- Extracted focused helpers and tests for family admin UI behavior, booking
  guest removal, membership cancellation blockers, admin audit queries, finance
  booking metrics, and Xero outbox payload parsing.
- Migration/deployment notes:
  - `20260527090000_add_booking_soft_delete_fields` adds nullable
    `Booking.deletedAt`, `Booking.deletedById`, and `Booking.deletedReason`
    columns, supporting indexes, and a `SET NULL` member foreign key. The
    ledger marks it as an expand migration that old code ignores; deploy during
    low booking traffic and let the deploy guard stop on lock timeout or
    migration failure before cutover.
  - `20260527120000_add_promo_redemption_allocations` creates
    `PromoRedemptionAllocation`, backfills one allocation per existing
    `PromoRedemption`, recalculates `PromoCode.currentRedemptions`, and installs
    insert/update triggers so old app colors continue writing one-booker
    allocations during blue/green drain. Run it during low promo-booking
    traffic.
  - `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` records both new migrations as
    expand-phase and old-code-compatible. They do not require a breaking
    migration override.
  - The production wrapper now resolves the deploy ref, derives SHA-tagged GHCR
    image references unless both `APP_IMAGE` and `MIGRATE_IMAGE` are supplied,
    creates a clean archive workspace, preserves the live Caddy upstream state,
    runs the integrated internal blue/green flow, syncs the source checkout to
    the deployed commit, and prunes stale deploy workspaces.

## 0.4.0 - 2026-05-26

- Added adopter-focused implementation and documentation index guides.
- Made public GHCR image publishing easier to reuse from forks.
- Removed completed repository-split planning artifacts from the public tree.
- Replaced remaining public-facing legacy TACBookings wording with generic
  booking-system language.
- Added admin-initiated membership cancellation requests and cancellation
  refund-policy copy in member/admin email paths.
- Expanded booking-change request handling with review-queue alignment, linked
  executed modifications, notification preferences, and refund-recovery
  coverage.
- Hardened payment, Xero, and external-service operations with Stripe webhook
  observability, stale recovery alerts, token redaction, and safer error
  handling.
- Continued maintainability work across booking creation/modification services,
  route boundaries, admin member pages, admin Xero panels, Xero integration
  modules, and the quality-report baseline.
- Added migration safety coverage for post-0.3.0 changes, including
  BookingGuest stay-range constraints and the promo-code per-individual
  redesign.

## 0.3.0 - 2026-05-24

- Added admin-managed email message configuration, previews, resets, delivery
  policies, and email message audit documentation.
- Added durable Stripe payment recovery and cleanup for superseded zero-dollar
  booking intents.
- Expanded booking editing with guest stay ranges, future-night edits,
  member/admin change requests, and Xero booking-edit settlement handling.
- Added membership cancellation workflows for member requests, confirmations,
  admin approval, participant handling, configurable settings, and Xero
  cancellation handling.
- Added governed member lifecycle flows for safe delete and archive requests.
- Improved admin and operational surfaces, including setup readiness, cron and
  payment maintenance, kiosk/lodge date scoping, finance metrics, and dark mode.

## 0.2.0 - 2026-05-21

- Added the setup wizard and Admin Modules settings/effective-state workflow.
- Tightened public onboarding, security headers, and issue-report origin
  handling.
- Ported generic public-site and module-migration fixes back to the shared
  reference application.
- Extracted booking policy and member credit ledger rules for clearer
  maintenance.
- Fixed cron health reporting for expected job history.
- Fixed zero-dollar booking batch edits so payment-pending bookings that become
  free are settled as paid.

## 0.1.0 - 2026-05-17

- Prepared the repository for a public MIT reference release.
- Added public governance, support, security, and contribution documents.
- Removed private audit queues, agent handoffs, and internal review artifacts
  from the public tree.
- Added public GitHub issue and pull request templates.
- Renamed public GHCR image packages to `alpineclubbookingsnz-app` and
  `alpineclubbookingsnz-migrate`.
- Published the initial AlpineClubBookingsNZ production application baseline.
