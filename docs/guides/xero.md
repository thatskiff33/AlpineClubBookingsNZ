# Xero Sync

Audience: Operator

## What it is

The dashboard for the club's operational **Xero** integration: monitor the
connection, run contact and membership syncs, work the outbound operations queue
and inbound webhook events, audit contact-group and link mismatches, and watch the
daily API budget. Day-one **account/item mappings and one-time import** live on a
separate **Xero Setup** page, and auto-grouping rules on the **Xero member
grouping** page. Find the dashboard at **Admin → Finance → Xero Sync**
(`/admin/xero`).

Xero is a **finance** permission area: finance view to read, finance **edit** to
run syncs, retry operations, replay events, or change mappings and rules. Most
panels appear only once Xero is connected. Xero pushes and reconciliation are
idempotent — retrying the same work never double-charges.

## When you'd use it

- You are connecting Xero for the first time, or reconnecting it.
- A booking invoice, payment, or subscription did not sync and you need to retry or
  investigate it.
- You want to import members from Xero contacts, repair link mismatches, or audit
  contact-group membership.
- You are preparing a club for its first real use and need every member to have
  a Xero customer before invoices start going out.
- A member has been erased here and you want to know whether they left a Xero
  customer behind.
- You are checking the daily Xero API budget or reconciliation health.

## Step-by-step

### Check the connection and health

1. Go to **Admin → Finance → Xero Sync**. The **Connection Status** panel shows
   whether Xero is connected (and the tenant/token), and the **Health Snapshot**
   summarises unlinked members, failed issues, pending operations, group/link
   mismatches, and API budget.

   > The whole Xero area (`/admin/xero`, `/admin/xero/*`, `/admin/internet-banking`)
   > is gated by the **Xero integration** module (`src/config/feature-routes.ts`)
   > and returns *Not Found* when it is off. The demo seed leaves Xero disabled,
   > so no screenshots are captured for these pages; enable the module to see them.

2. Use **Connect Xero** / **Disconnect Xero** on the connection panel.
   Disconnecting stops invoicing, payment reconciliation, subscription paid-status
   detection, and finance syncs until you reconnect (your data inside Xero is not
   changed).

3. **Go to Xero** (top right of the page) opens Xero in a new tab so you can
   chase up whatever you just spotted. It sits in the page header, so it is
   there whichever sections you have expanded. When
   the club's Xero organisation is known, the link takes you straight into *that*
   organisation's dashboard — useful if your Xero login covers several
   organisations. If the app cannot read the organisation, or Xero is not
   connected here, the button still works: it becomes a plain Xero sign-in
   (labelled **Log in to Xero**) and Xero decides which organisation you land in.
   It is never disabled, because opening Xero is exactly what you want when the
   connection here is broken.

### Run syncs and work the queues

1. **Contact Sync** runs a broad link pass (**Sync Contacts from Xero**) or a
   **Targeted force sync** to repair a single member, invoice, or membership.
2. **Membership Status Refresh** checks Xero invoices for active members
   (**Incremental Refresh** or **Repair Backfill**) — this also runs as a daily
   cron, and only linked members are refreshed.
3. **Xero Operations** lists outbound sync attempts; retry active failures, reset
   stale running jobs, or mark an individual operation non-replayable / resolved.
   **Inbound Events** lists stored webhooks with a per-event **Replay**. Each
   queue has its own **Reset** for filters and page; it keeps the current section,
   the sibling queue's URL state, and unrelated URL context.

### Create or link a member's Xero contact

1. On a member's admin page (or the members-list editor), the **Xero** panel lets
   you **link** an existing Xero contact or **create** a new one.
2. **Creating a contact needs only a first name, last name, and email.** Email is
   required because Xero uses it for invoice delivery and contact matching;
   everything else — phone, date of birth, joined date, and both the postal and
   physical addresses — is optional. Xero's contact-create API itself requires
   only a unique contact name.
3. When optional profile fields are blank the panel shows a small note (e.g.
   *"Profile incomplete: postal address, joined date — missing details will
   simply be left off the Xero contact"*) and still lets you create the contact. Blank
   addresses and an all-blank phone are simply omitted from the payload rather
   than sent as empty blocks. Date of birth and joined date are never sent to
   Xero on create; the joined date round-trips only through Xero's *company
   number* field on the import/backfill path.
4. Before a brand-new contact is created the app checks for **similar existing
   Xero contacts** and asks you to confirm if any are found, so link an existing
   contact where one already exists.
5. If Xero creates the contact, or the local link/import/unlink commits, but a later
   bookkeeping or subscription step fails, the page says exactly which part is
   already complete. **Do not repeat Create, Link, Unlink, or Import.** Check the
   reloaded member and follow the displayed **Member Status Repair Backfill** remedy
   when refresh or cleanup remains pending.
6. That recovery warning stays visible while the current view reloads and if the
   reload fails. On member detail, use **Try again** from the warning. The members
   list refreshes its current results automatically; Contact Sync and diagnostics
   direct you to reload the status or open the affected member before another
   Xero action.
7. Linking a member to the contact Xero already created is the remedy for the
   "contact created, link unconfirmed" case, and it now also **closes that
   operation**, so the member can be merged and deleted again straight away. If
   Xero turns out to hold a *different* contact for the member, the operation
   deliberately stays open — that is a duplicate for someone to look at — and the
   member's Xero panel says which operation is blocking their merge and deletion,
   and where to clear it.
7. If the app can prove only that a contact create is still running or awaiting
   recovery, it says exactly that and hides **Create in Xero** without claiming a
   contact was created. Resetting the stale operation does not make Create safe:
   reload the member, then explicitly resolve the operation only after checking
   Xero and the member's current link.
8. Profile/contact updates reserve the current member and Xero contact before
   sending anything. A failed member update retry is rebuilt from the member's
   current profile and link; it never replays the stored request if that member
   was deleted, merged, or unlinked.
9. Account deletion and Xero contact writes exclude one another. If either page
   asks you to reload and retry, check the member and deletion request first; do
   not repeat Create or Link while deletion or contact recovery remains pending.
   A deleted/anonymised member cannot be sent to or re-linked with Xero, and its
   former active contact ledger is retired with anonymisation.

### Create the missing Xero contacts in bulk

Use this when a club is starting out, or coming back after a spell where members
were added here but not in Xero, and nobody knows how many members have no Xero
customer. It lives in **Members with no Xero contact** on the Xero Sync page and
it works in two halves: a dry run that only reads, then a confirmation that
creates a small batch at a time.

1. Run **Contact Sync** first. Until Xero's contacts have been pulled in at
   least once, the dry run cannot tell who already has a contact — it says so
   and refuses to answer rather than showing you counts that would send you
   towards duplicates.
2. Open **Members with no Xero contact** and press **Run the dry run**. Nothing
   is written here and nothing is sent to Xero. You get counts and three lists.
3. **Ready to create or link** is what the confirmation will act on. A row
   marked as matching an existing Xero contact will be *linked* to it, not given
   a second one; a row with no match is still searched for in Xero live before
   anything is created, because a missing link here is not proof that Xero has
   no contact.
4. **Needs a decision** is the list worth your time. Nothing is done for these,
   because each one has more than one defensible answer: two members sharing an
   email address, an address that belongs to a school's own Xero customer,
   several Xero contacts on one address, or a contact under a different name.
   Fix the underlying record — give a dependant their own address, link a
   contact by hand from the member's Xero panel, tidy duplicates in Xero — and
   the member moves into the first list on the next dry run.
5. **Not eligible** is informational: school records, anonymised accounts,
   walk-in placeholders with no real address, and members missing a first name,
   last name or email.
6. Press **Create the next N**. You will be asked to confirm, and the
   confirmation states exactly what is about to happen — how many brand-new Xero
   contacts will be created and how many members will be linked to contacts Xero
   already has. The batch size is chosen for you from what each member costs in
   Xero API calls, so it is smaller on a club that uses contact groups.
7. One member failing does not stop the batch. For **almost every** failure the
   member is left exactly where they were and the next run picks them up with
   nothing duplicated — a failed Xero search, a name that collides with an
   existing contact, a contact that belongs to a school. The one exception is a
   row that says the action **completed only in part**: there, something did
   reach Xero, and the rule for that is the same as everywhere else on this page
   — *do not repeat the action*, resolve it from **Operations** instead. The
   result list names every member and says which of these happened to them.
8. Run the dry run again and repeat until the count reaches zero.

> Running it twice is safe, with that one exception. Every contact goes through
> the same path a booking invoice uses, which searches Xero first and carries a
> per-member key, so a repeat converges on the one contact rather than making a
> second.

### Check what an erasure left in Xero

Erasing a member here removes their details from this application. It **does not
ask Xero to change, archive or delete their contact**, and that is deliberate:
Xero is the club's accounting system, it is administered separately, and that
decision is not this application's to make. So where an erased member had a Xero
customer, that customer is still in Xero — and until now nothing told you so.

> **What erasure does do in Xero.** It cancels the member's future bookings, and
> cancelling one they had paid for raises a credit note, exactly as any other
> cancellation would. That is ordinary accounting, and it is the only thing an
> erasure causes in Xero. The contact itself is never touched.

**Erased members with a Xero contact** on the Xero Sync page is that telling. It
is a notice rather than a tool: nothing on it changes anything in Xero, and the
one button that reaches Xero at all only asks it a question.

1. Open the section. It lists one line per Xero contact that an erasure left
   behind, oldest erasure first, with a link straight to that contact in Xero.
2. Each line says which kind of erasure it was. An **account deletion request**
   leaves the member record here with the person's details removed, so the id is
   a link you can follow. A **member delete** removed the record altogether, so
   the id is shown but goes nowhere.
3. Decide in Xero, if you decide anything at all. Archiving the contact, merging
   it with another, editing it or leaving it exactly as it is are all legitimate
   answers, and this application is not asking for any of them. Invoices and
   accounting history raised against a contact stay valid and usable whatever
   you choose.
4. When you have archived some of them, press **Check these in Xero**. That asks
   Xero about the contacts on the list — archived ones included — and the ones
   you have dealt with drop off it, counted instead of listed.

> **Who can do what here.** Anyone with finance access can read the list.
> Pressing **Check these in Xero** needs finance *edit* access, because it
> spends a share of the club's daily Xero allowance — and if that allowance runs
> out, invoice and payment syncing stop for the rest of the day. If you can see
> the list but the button is greyed out, that is why.

> **Contact Sync will not do that for you, and nothing else will either.** It
> only fetches contacts that are *not* archived, so the moment you archive one
> it becomes invisible to it; and the erasure deleted this application's cached
> copy of the contact, so there is nothing here for it to update. The button is
> the only thing that ever makes this list shrink. A line you never deal with
> stays on the list indefinitely, which is correct — there really is a customer
> in Xero that nothing here points at any more.

> Nothing here names the erased person, and the check does not bring their
> details back: it keeps the contact's status and nothing else. The lines carry
> an id and a link, because the details are exactly what the erasure removed —
> and they are still in Xero, where they are yours to read.

### Set up mappings and import (Xero Setup)

1. Open **Xero Setup** (`/admin/xero/setup`, back-linked from **Integrations**) to
   configure account and item **mappings** and run one-time import/link tools.
2. **Import Members from Xero** maps each contact group to an age tier and can send
   invite emails; **Repair Canonical Links** and **Scan for Duplicates & Family
   Groups** clean up the link ledger.

### Manage auto-grouping (Xero member grouping)

1. **Xero member grouping** (`/admin/xero/member-grouping`, also linked from the
   sidebar) chooses the grouping **mode** (None / Membership Type / Membership Type
   + Age) and the **rules**. Each rule can target a **set of age tiers** — tick
   any subset, or tick none for **"All age tiers"** (the wildcard). When rules
   overlap, the **most specific wins**: `type + tiers` beats `type-only` beats
   `tiers-only`, and among tiered rules **fewer tiers is more specific** (an
   "all age tiers" rule is the least specific). A **"Refresh from Xero"** button
   re-pulls the contact-group cache and a **"Last synced"** header shows when it
   last refreshed; a read-only **dry-run diff** must be reviewed before any
   heavyweight **bulk re-sync**. Changing a mode or rule (including a tier set),
   or refreshing from Xero, never re-groups existing members automatically and
   invalidates any prior dry-run. For the full cutover procedure, follow the
   [Xero member grouping runbook](../XERO_MEMBER_GROUPING_RUNBOOK.md).

## Settings reference

| Area | What it does | Notes / constraints |
| --- | --- | --- |
| Connect / Disconnect Xero | Establish or remove the operational Xero connection | Finance edit; disconnect stops invoicing/reconciliation/paid-status |
| Contact Sync / Targeted force sync | Broad or single-record contact link/repair | Finance edit |
| Membership Status Refresh | Refresh current-season paid status from Xero | Also a daily cron; linked members only |
| Xero Operations | Filter and page outbound work; retry / reset / mark non-replayable / resolve it | Dataset Reset keeps the section and Inbound state; write actions need finance edit and are idempotent |
| Inbound Events | Filter and page stored webhooks; replay an event | Dataset Reset keeps the section and Operations state; Replay needs finance edit |
| Xero Setup → Mappings | Account/item code mappings and hut/joining fee item codes | Finance edit; joining-fee amounts live in [Fees](fees.md) |
| Member grouping | Grouping mode + rules, dry-run, bulk re-sync | Finance edit; never auto-re-groups; runbook-driven cutover |
| Members with no Xero contact | Dry run over unlinked members, then create or link in small batches | Finance edit to create; needs a Contact Sync first; schools and ambiguous rows are never acted on; the batch size is shown on the button |
| API budget / Usage | Daily call volume, rate limits, recent failures | Read-only meter |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Only the Connection panel shows | Xero is not connected | Click **Connect Xero**; the sync/health panels appear once connected |
| Xero Setup's **Connect** step cannot confirm the organisation name | The one read that fetches the name failed — Xero was busy, briefly unreachable, or the authorisation is no longer accepted | The step now says which of those it was and what to do. **Xero needs re-authorising**: disconnect and connect again (no button is offered, because retrying cannot fix it). **Xero's daily limit reached**: the cap resets at midnight UTC (about midday in New Zealand); **Try again** is still offered, since the reset may land while you are on the page. **Per-minute limit / could not reach Xero**: press **Try again**. Each press makes at most one fresh call — nothing retries by itself, so it never spends Xero calls you did not ask for |
| The Connect step says **your admin role cannot read the Xero organisation details** | Your role has no finance access | Ask a full admin to finish the step, or to give your role finance access. No **Try again** is offered, because it cannot help |
| The Connect step says **your sign-in has expired** | The session went, not the permission — nothing is wrong with your role or with Xero | Sign in again (another tab is fine), then press **Try again**. Nothing entered in the wizard is lost |
| The Connect step shows the organisation as **"the last organisation we saw"** rather than a green tick | The name came from cache because the live re-check failed — most often because the club revoked this app inside Xero's own **Connected apps** screen, which leaves the stored connection looking healthy | Treat the name as unconfirmed. Follow the warning above it: usually disconnect and connect again, re-authorising the app in Xero |
| Operations/events are read-only ("… can view Xero operations but cannot retry…") | Your finance role is view-only | Ask a finance-edit admin |
| An outbound operation is stuck **Failed** | A push failed and needs a replay (or was fixed directly in Xero) | **Retry in background**, or **Resolve (fixed in Xero)** with a reason |
| A member's grouping looks wrong | The mode/rules changed but existing members were not re-grouped automatically | Run the **dry-run diff**, then **bulk re-sync** per the [runbook](../XERO_MEMBER_GROUPING_RUNBOOK.md) |
| A bulk re-sync halted | The daily Xero API limit was reached | Use **Resume re-sync** the next day |
| Subscription paid-status isn't updating | The member has no Xero contact link | Link/create a contact, then run a membership refresh |
| Create/link/unlink/import says the action completed only in part | The provider or canonical member change committed before a later local step failed | Do not repeat the action; reload/try again from the persistent warning, check the current link, then run **Member Status Repair Backfill** when directed. The message also names anything else left unfinished — the member's **Xero record links may still be active** (check them on the member and deactivate any that remain), and the **audit entry may be missing** so the action may not appear in the member's history |
| **Member merge** or **account deletion** is refused for a member whose Xero contact looks fine | An open member CONTACT operation still blocks both, most often a create whose Xero contact was made under a different id | The member's Xero panel and the refusal both name the operation. Open **Xero → Operations**, find it, and either wait for it to finish or use **Resolve (fixed in Xero)** once the contact is correct in Xero. Linking the member to the contact that create actually made closes it by itself |
| The dry run says Xero contacts have never been synced | The local copy of Xero's contacts is empty, so every member would look like they have no contact | Run **Contact Sync** on this page first, then run the dry run again |
| The dry run warns that the cached contact list is old | The counts come from the last Contact Sync, and a contact added in Xero since then looks here like no contact at all | Run **Contact Sync**, then the dry run again, before creating anything |
| Creating is refused because "what would happen has changed" | Something moved between the dry run you reviewed and pressing the button — a contact was found, archived or claimed | Nothing was created. Run the dry run again and review the new plan |
| A row failed saying Xero could not be searched | The search failed for a reason other than the daily limit, so nothing was done rather than risk a second contact for somebody who already has one | Try again later. The member is unchanged |
| A row failed saying Xero already has a contact with this name | Xero will not allow two contacts with the same name, and nothing here decides on a name alone whether it is the same person | Check the contact in Xero. Link this member to it by hand if it really is them, or rename the old contact |
| A member stays in **Needs a decision** after a batch | Nothing is ever guessed for these rows — the batch deliberately skipped them | Read the reason on the row and fix the record it names: split a shared email address, link a contact by hand from the member's Xero panel, or tidy duplicate contacts in Xero |
| A batch stopped part way saying Xero's daily limit was reached | The club has spent its Xero API calls for the day | Nothing is half-done: come back tomorrow, run the dry run again, and carry on. The limit resets at midnight UTC, about midday in New Zealand |
| A row failed saying the Xero contact belongs to a school | That Xero customer is the school's own record, and one Xero customer belongs to one local record | Give the person their own email address, or link them to their own contact by hand. Never re-use the school's contact for a person |
| **Force sync → Contact** for a walk-in owner | Walk-in owners have a placeholder email, so Xero cannot be searched by email for them | It works: the re-sync asks Xero by exact name instead. A live contact with that name is re-linked; only when Xero has no live contact of that name is a new one created |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: the [Xero subsystem architecture](../xero/ARCHITECTURE.md) and the
  [Finance dashboard](../finance-dashboard/README.md).
- Sibling guides: [Subscriptions](subscriptions.md), [Payments](payments.md),
  [Internet Banking](internet-banking.md), [Members](members.md).
- Reference: the
  [Xero outbox and reconciliation lifecycle](../STATE_MACHINES.md#xero-outbox-and-reconciliation-lifecycle),
  the [Xero member grouping runbook](../XERO_MEMBER_GROUPING_RUNBOOK.md),
  [operational Xero](../ARCHITECTURE.md#operational-xero) and the
  [Xero member grouping](../../CONFIGURATION.md#xero-member-grouping) reference,
  and the [Xero member grouping invariants](../invariants/integrations.md#xero-member-grouping-e8-1934).
