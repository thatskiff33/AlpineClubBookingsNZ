# Environment Safety

Audience: Operator, Adopter

## What it is

Every installation of this site is either **the club's live site** or **a copy of
it** — a staging site, a rehearsal after restoring last night's backup, or a
developer's laptop. This setting is where that is written down. Find it at
**Admin → Setup & Configuration → Environment Safety** (`/admin/environment`),
and on the first-install checklist as the **Production Or Non-Production** step.

It matters for one reason. A copy restored from the live database contains the
club's **real members and their real email addresses**. So anything that leaves
this application — a booking confirmation, a subscription reminder, an invoice
written into the club's Xero organisation — has to know which installation it is
running on before it goes out.

**The site never guesses.** The deployment says so explicitly, in one setting
(`APP_ENVIRONMENT_ROLE`, set outside the app in the deployment's environment),
and where nothing says, the answer is *not configured* rather than either one.
That is deliberate, and the "Why nothing is guessed" section below explains why
the obvious shortcuts are all wrong.

## When you'd use it

- **You are setting up a new installation**, live or otherwise, and the setup
  checklist is asking you to declare which it is.
- **You have restored a copy of the live database** onto a test site and want to
  be certain nothing from it can reach real members.
- **You are upgrading an existing live site** to this release or later, and need
  to add the declaration before the deploy will run.
- **Members have stopped receiving email** and you want to check whether this
  installation knows it is the live site.
- **Somebody asks who put this site into "copy" mode** and when.

## Step-by-step

### Read what this installation is

1. Go to **Admin → Setup & Configuration → Environment Safety**.
2. The panel at the top says one of three things:
   - **Production — the club's live site.** Emails go to real members and
     accounting goes to the club's real Xero organisation.
   - **Non-production — a copy.** Treated as a copy, whatever it holds.
   - **Not configured.** Nothing has said. See "What 'not configured' means"
     below — it is not the same as either of the other two.
3. Underneath, the page shows the two things that decide it: what the
   deployment's own configuration says, and whether the safer override is on.
   Where they disagree, it says which one won and why.

### Declare a live site

This is not done in the app, on purpose: a copy of the live database must not be
able to declare itself the live site.

1. On the server, open the deployment's `.env` file.
2. Add or correct the line:

   ```
   APP_ENVIRONMENT_ROLE=production
   ```

3. Deploy, or restart the app. `/admin/environment` and the setup checklist will
   then both report **Production**.

### Declare a copy

Same file, the other value:

```
APP_ENVIRONMENT_ROLE=non-production
```

The staging and end-to-end test stacks already declare this for you
(`docker-compose.staging.yml` sets it), so you only need to do this by hand for a
copy you have brought up yourself.

### Force a copy to stay safe, from inside the app

Use this when you have just restored a copy of the live database and want a
belt-and-braces guarantee while you work on it — particularly if you are not
certain what the deployment's own setting says.

> **It is stored in the database, so the next restore removes it.** This switch
> lives in the copy's own database — which is the file you replace every time you
> restore a fresh copy of the live data. After such a restore the row is gone,
> absent means off, and the copy goes back to whatever the deployment's own
> setting says. On a copy that inherited the live `.env` that means it resolves
> **Production** again, which is the very case this switch was protecting you
> from. So treat it as the immediate fix, and make it durable by setting
> `APP_ENVIRONMENT_ROLE=non-production` in the copy's own environment (above) —
> that lives outside the database and survives every restore.

1. Go to **Admin → Setup & Configuration → Environment Safety**. You must be a
   **Full Administrator**; other admins, including one holding every permission
   area at *edit*, see a short "available to full administrators only" panel.
2. Choose **Switch the override on**.
3. Read the consequences, tick the acknowledgement, then **Save**.

Nothing already recorded changes — no booking, payment, member or invoice is
touched. What changes is how this installation behaves from now on.

To undo it, choose **Switch the override off**. That is equally privileged and
equally audited, and it **does not** make an installation the live site: the
deployment's own setting decides again, so an undeclared installation goes back
to *not configured*.

## What "not configured" means

It means **nothing has said**, and the site refuses to pick for you.

It is **not** production. It is also **not** confirmed non-production — those are
different states with different consequences, and treating "we do not know" as
"this is a copy" would be its own guess. So anything whose safety depends on
knowing which installation this is is **held back** until you declare it. In
practice that means email to members and writes into the club's Xero
organisation.

If you meet this on a live site, the fix is one line in the deployment's `.env`
(above) and a restart. The setup checklist reports it as a **blocked** step with
that instruction, and the app logs an error at start-up naming the setting.

Held-back email is **not** lost while you sort this out. A message the site
refused to send because it could not tell what this installation is is recorded
as a failed send and goes out **by itself** on the next retry pass once you have
declared the role — you do not have to re-trigger anything. The one exception is
the deliberate case: on a confirmed **copy**, a held-back message is final and is
never replayed, because a copy that is later re-declared as the live site must not
suddenly post weeks of stale confirmations to real members.

## Email held back, and the number that tells you whether it matters

Both **not configured** and **non-production** show how much application email
this installation has held back, and when the most recent one was — on
Admin → Environment and on the checklist step.

**The live site shows it too, in one case.** If a deployment says it is the club's
live site *and* points its mail at a capture mailbox, those cannot both be true, so
every message is refused rather than silently swallowed — a total mail outage. That
count appears on the live site as well, with its own wording and its own repair,
because the answer there is not "your declaration is wrong" but "your two mail
settings contradict each other". Otherwise nothing is held back on the live site
and the line is not shown.

**That number is the one thing that tells a live club which has stopped sending
apart from an ordinary idle copy**, because no property of the data can: a copy is
restored from the live database and holds exactly the same records. What separates
them is consequence. A real club withholds a steady, recent stream —
confirmations, payment notices, renewal reminders, hour after hour. A copy nobody
is using withholds almost nothing.

Three readings, and they mean different things:

- **A number, recent and climbing.** If members are waiting for that mail, the
  answer above this line is wrong — either the declaration says *copy* when this
  is the live site, or nothing has declared it at all. Fix that, and most of what
  is queued goes out on its own.

  **Some of it will not, and you have to send those by hand.** A message that
  carries something which must not be stored — a sign-in link, a door code, a
  payment link — keeps no copy of itself, so there is nothing left to re-send
  automatically. Those messages are listed under **Admin -> Email** for review,
  each one saying plainly that it needs a manual re-send, and the list is where to
  go once the declaration is corrected.
- **None.** Nothing has been held back. That is what an installation nobody is
  using looks like.
- **Not available.** The count could not be read from the database — usually a
  migration that has not been applied here. It is *not* the same as none: one says
  nothing has been held back, the other says nobody knows.

## What a copy does to the club's Xero contacts

**Audience: operator.**

This is the part people are most often surprised by, so read it before you point
a copy at Xero.

A copy does **not** stop writing to Xero. It goes on raising invoices and credit
notes exactly as the live site would, on purpose: an invoice that is never raised
cannot be paid, settled or reconciled, so a copy that stopped raising them would
be useless for testing the very things people restore a copy to test. What changes
is who those documents can reach.

**The reason it has to change at all is that Xero emails on its own account.**
When an invoice is outstanding, Xero's own invoice reminders go out from Xero's
servers to whatever email address is stored on the contact — this application is
not involved and cannot hold them back. So on a copy, the first time a Xero
contact is needed, this application replaces the email address on that contact
with one that can never be delivered. After that, Xero has nobody to email.

**On a copy connected to the club's REAL Xero organisation, that is a real edit
to real accounting records.** The addresses are gone from Xero, though they are
still correct in the database. So:

- Point a copy at a **separate Xero organisation** wherever you can — a demo or
  trial organisation. Then containment only ever touches records nobody minds.
- If a copy has already been connected to the real organisation, Admin →
  Environment lists **which contacts had a working address replaced** — the
  member's name, a link straight to that contact in Xero, and when it happened.
  Putting them back is the next section.
- **Switching the safer override on does not stop this — it starts it.** That
  switch forces the installation to behave as a copy, and behaving as a copy is
  the only state in which addresses are replaced at all. So on an installation
  that was resolving *production* (or *not configured*) and is connected to the
  club's real Xero organisation, switching it on **begins** editing real
  contacts. What it does stop is email to members. To stop Xero work on a copy,
  disconnect Xero on that installation, or point it at a different Xero
  organisation.

### Putting a replaced address back

**Audience: operator.**

This is a manual job, and the honest version of why is worth two sentences,
because the obvious expectation is a button.

**The application cannot do it for you, in either direction.** A copy is not
allowed to write a real address to a Xero contact — that is the whole point of
the replacement, and doing it would start Xero emailing real members again. And
the club's live site cannot find the damage on its own: the record of what a copy
changed lives in *that copy's* database, not in the live one. There is no route
that pushes a member's stored address onto a contact that already holds
something, either: the admin force-sync links a contact rather than pushing an
address to it, "push to Xero" refuses a member who is already linked, and the
ordinary contact update only fires when a field changes *locally*.

So, per contact:

1. On the **copy**, open Admin → Environment and read the list of contacts whose
   address was replaced. Each row links to the contact in Xero and names the
   member it belongs to.
2. On the club's **live site**, open that member's page and copy their email
   address. It was never changed there — only Xero's copy of it was.
3. In **Xero**, on the club's real organisation, open that contact and put the
   address back.

Then point the copy at a separate Xero organisation, or disconnect Xero on it,
before using it again.

**What the replacement looks like.** Every contact gets an address like
`contained-<a long string of letters and numbers>@xero-sandbox.invalid`. It is
derived from the real address, so the same person always gets the same one — which
is what lets you tell at a glance that a contact has been contained rather than
edited by hand — but the real address cannot be read back out of it. `.invalid` is
a reserved ending that no mail system anywhere will deliver to.

**What it is NOT.** This is deliberately a different kind of address from the
`no-email.invalid` one the app uses for a walk-in guest who never gave an address.
That one means *this person cannot be reached*, and the app uses it to skip
reminders and to mark a member unreachable on admin screens. A contained member
can be reached perfectly well — on the live site, by the club — so they are not
marked unreachable, and a copy therefore keeps behaving like the live site.

**Importing members from Xero on a copy.** The two "import this Xero contact as a
member" tools refuse a contact whose address has been contained, and say so. They
have to: a member created from a contained address would look reachable on every
screen and be able to receive nothing at all. Do those imports on the live site.

**How often a contact is re-checked.** Once a contact's address has been
replaced, the copy records that it has been dealt with and does not ask Xero
about it again for a day — otherwise every invoice on a large club would cost a
round trip per member. After a day it looks again. That matters if somebody
edits the address back by hand, or repairs it from the live site: for up to a day
afterwards the copy still believes that contact is dealt with, and will not
notice. It is not a hole you can fall into by accident, but it is the reason to
finish a repair by moving the copy off the real Xero organisation rather than by
leaving it pointed there.

### While the role is "not configured", nothing is WRITTEN to Xero

This is stricter than the email rule, and it is worth knowing before you see it.
An installation that has not said whether it is the live site or a copy writes
**nothing** to Xero — no invoice, no credit note, no contact, no payment, no
credit allocation, nothing at all. The reason is that the answer decides what
address may sit on a contact: the member's real one on the live site, a replaced
one on a copy. Guessing wrong in one direction emails real members from a copy;
guessing wrong in the other rewrites the club's real accounting. Neither is
acceptable, so nothing is attempted.

**Reading from Xero still works**, on purpose. The Xero screens in this
application still load, reports still run, and the contact sync still refreshes
its cache — none of that marks the club's books, and somebody working out why
their invoicing has stopped needs to be able to look.

Declare the role and Xero writing resumes. Anything that was refused can be
re-driven from **Admin → Xero**; nothing was half-written, because the refusal
happens before the first call.

## Letting a copy send into a capture mailbox

A copy normally sends nothing at all. That is the point. But a test installation
often needs to *see* the mail it would have sent — to check a template, or to
read a sign-in code back during automated testing.

Declare a **capture mailbox** for that: set `USE_LOCAL_CAPTURE=true` and point
`EMAIL_SERVER_HOST` and its three companions at a local mail sink (mailpit,
MailHog, or anything that accepts SMTP and forwards nothing). A confirmed copy is
then allowed to transmit into it, and those messages appear as ordinary sent mail
— because they *were* sent, into something that cannot pass them on.

An installation that is **not configured** gets no such permission: a capture
declaration comes from the same deployment configuration that has failed to say
what this installation is, so it earns nothing until that is answered.

Three things worth knowing:

- **It is a declaration, not a detection.** The app does not look at the host name
  and decide that something called `mailpit` must be safe. You say it is a
  capture; nothing infers it. The flip side is that declaring capture mode against
  a relay that really can deliver would send real mail from a copy, and the
  application cannot tell. That is the same family of mistake as declaring the
  live site a copy, and it has the same answer: the deployment says what it is,
  explicitly, and somebody reads it back.
- **The club's live site refuses it.** An installation declaring
  `APP_ENVIRONMENT_ROLE=production` *and* `USE_LOCAL_CAPTURE=true` is refused
  outright, because a live site in capture mode would accept every message,
  record every one as sent, and deliver none of them — a silent total mail
  outage. Set `USE_AWS_SES` or `USE_SMTP_RELAY` there instead.
- **It does not cover invoice emails.** A capture catches the mail this
  application sends itself. When the club's accounting system emails an invoice,
  it sends that from its own servers to the address stored on the member's
  contact, so no local capture ever sees it — and a copy therefore does not ask
  for it at all, capture mailbox or no capture mailbox.

## Why nothing is guessed

Every cheap way of telling "am I the live site?" is wrong in a way that only
shows up on the day it matters:

| The tempting shortcut | Why it is wrong |
| --- | --- |
| `NODE_ENV=production` | A **build** mode, not a deployment identity. The staging stack runs a production build, so this says `production` there too. |
| `APP_RUNTIME_ROLE` | Names which container **slot** a process is (`web-blue`, `web-green`, `cron-leader`, `staging`). A deployment naming convention. **Setting it to `production` changes nothing here** — see the warning below. |
| The hostname or the site URL | DNS, and a copy can be given any name. |
| The database it is pointed at | A copy restored from the live database is byte-for-byte the live data. |
| Which branch was deployed | Says what the code is, not what the installation is. |

Each is a convention that holds right up until somebody stands up a copy that
breaks it — and that is precisely the copy that will email the club's members.

> **`APP_ENVIRONMENT_ROLE` is not `APP_RUNTIME_ROLE`.** They sit next to each
> other in the same Compose configuration and differ by one word, and on the
> staging stack `APP_RUNTIME_ROLE` literally holds the word `staging`. If you
> edit the wrong one, nothing you were trying to change will change. Both
> plausible mistakes are made to fail safely rather than silently:
> `APP_ENVIRONMENT_ROLE=staging` is **refused** (it is not one of the two
> accepted values) and leaves the site *not configured*, and
> `APP_RUNTIME_ROLE=production` changes no safety decision at all.

## Upgrading an existing live site

An installation set up before this release has no declaration, so on its own it
would come back as *not configured* and stop sending member email. Three things
stop that happening quietly.

**The production deploy refuses to run without it.**
`scripts/run-production-blue-green-deploy.sh` checks the `.env` entry at **step 3
of 20** — before the database migration (step 13), before the new release's first
process starts (step 14), and long before the traffic cutover (step 17). An
undeclared upgrade therefore **aborts with the previous release still serving and
nothing changed**. You add the line and run the deploy again.

**It refuses the opposite mistake too, and that one is easier to make.** That
script deploys the club's live site and nothing else — there is no staging mode in
it — so it also refuses a `.env` saying `APP_ENVIRONMENT_ROLE=non-production`.

The reason is worth understanding, because the mistake is a natural one.
`.env.example` ships `non-production`, which is correct for that file: it is a
local-development template, and one shipping `production` would have every
developer's laptop declaring itself the live site. But `.env.example` is also the
file you diff against your real `.env` when upgrading, and "a new key appeared in
the template, copy it across" is the normal move. If the deploy accepted it, the
upgrade would succeed, the new release would come up believing it was a copy, and
every real member's email would be held back — and once the Xero containment
lands, the email addresses on the club's **real** accounting contacts would be
rewritten to sandbox addresses. So the deploy stops, and says exactly that.

**The deploy also checks what each container actually received.** Validating the
`.env` file and validating what the containers were given are different
questions: Docker Compose prefers a value set in the shell you ran the deploy
from over the file, and takes the last of any duplicate lines rather than the
first. So at **step 14** — the new release started, the previous one still taking
every request — the deploy **asks the running application itself** which
declaration it read, and stops before the cutover if any container answers
anything other than `production`. It also refuses a duplicated entry and a shell
value that disagrees with the file, and says which is which.

That check asks the app rather than re-reading the container's settings, on
purpose: a second copy of the rule is a second thing that can drift away from the
first, and this one is the check that has to be right when the file check is not.

**And the app says so loudly if an undeclared installation ever does come up** —
for example on a deployment brought up by hand with `docker compose up` rather
than through that script, which runs none of the checks above. Start-up logs an
error explaining the specific cause, and the setup checklist reports the
**Production Or Non-Production** step as blocked. An installation that comes up
as a *copy* says so at start-up too, and names which of the two sources decided
it, so an operator who did not expect it can tell whether to look at the `.env`
or at this page.

### After the deploy, read the message and not the tick

Open **Admin → Setup** and look at the **Production Or Non-Production** step. It
must say **production**.

This is worth spelling out because a *non-production* installation also shows a
green tick there — both are validly configured states, and the checklist cannot
know which one your installation is supposed to be. So the tick only tells you
that the question has been answered; the step's message is what tells you *which
answer*, and on the club's live site the only correct one is production.
`/admin/environment` says the same thing in more detail.

## Settings reference

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| `APP_ENVIRONMENT_ROLE` | Whether this installation is the club's live site or a copy | **None — required** | Exactly `production` or `non-production`. Case and surrounding spaces are ignored, and the deploy check also accepts the shapes `.env` files normally carry: an `export ` prefix, spaces around the `=`, quotes round the value, and a leading indent. Anything that is not one of the two words is refused, not interpreted. Set in the deployment's environment, never in the app. Passed through `docker-compose.yml` with **no default** on purpose. |
| Safer override | Forces this installation to be treated as a copy, whatever the deployment says | Off | Full Administrator only, confirmed, and audited. Can only ever make the answer *safer*; there is no setting anywhere in the app that can declare an installation to be the live site. |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The page says **Not configured** | `APP_ENVIRONMENT_ROLE` is not set in this deployment's environment | Add `APP_ENVIRONMENT_ROLE=production` (live site) or `=non-production` (a copy) to the deployment's `.env` and restart |
| It says a value was **refused**, and quotes it | The setting holds something other than the two accepted words — commonly `prod`, `staging`, or a value copied from `APP_RUNTIME_ROLE` | Correct it to exactly `production` or `non-production` |
| I set `APP_RUNTIME_ROLE` and nothing changed | Wrong setting — that one names the container slot | Set `APP_ENVIRONMENT_ROLE` instead |
| Members stopped receiving email after an upgrade | The installation is *not configured*, so delivery is being held back | Declare the role as above; check the **Production Or Non-Production** step on `/admin/setup` |
| The deploy aborted at step 3 saying the entry must be exactly `production` | Working as designed — the declaration is missing, or it says `non-production` on the live site | Set `APP_ENVIRONMENT_ROLE=production` in `.env` on the server and run the deploy again. Nothing was migrated or switched |
| The deploy refused a `.env` I copied from `.env.example` | That template holds `non-production`, which is right for a laptop and wrong for the live site | Change the value to `production`. The template is not meant to be copied wholesale into a live deployment |
| The setup step shows a green tick but members still get no email | The tick means "declared", not "declared production" — read the message | If it says non-production, set `APP_ENVIRONMENT_ROLE=production` and restart |
| The page says the override **could not be read** | The database migration for this release has not been applied here | Run `prisma migrate deploy` (or `npm run db:migrate` in development) and reload |
| It says **Production** but this is a copy | The copy inherited the live `.env` | Set `APP_ENVIRONMENT_ROLE=non-production` on the copy, and switch the safer override on now if you need it safe immediately |
| It says **Not configured**, but the line is clearly there in `.env` | Something else is overriding it: another `APP_ENVIRONMENT_ROLE` line further down the file, or a value set in the shell or service manager that starts the app. Both beat the line you edited | Search the whole file for `APP_ENVIRONMENT_ROLE` and leave one line; then check the shell or systemd unit that starts the stack |
| The deploy says the entry appears **twice** | `APP_ENVIRONMENT_ROLE` is set on two lines of `.env` | Delete all but one. This is refused rather than resolved because Docker Compose would use the last line and the deploy check reads the first, so the two could disagree about the most consequential setting in the file |
| The deploy says the value **disagrees between this shell and `.env`** | Something exported `APP_ENVIRONMENT_ROLE` into the shell you ran the deploy from — a wrapper script, a systemd unit, a restore rehearsal. Compose would use the shell's value, not the file's | Run `unset APP_ENVIRONMENT_ROLE`, remove it from whatever exported it, then run the deploy again |
| The deploy says a container reported the wrong **environmentRole** at step 14 | The container received a different value from the one `.env` holds, so the two checks above are worth re-reading | Nothing was switched — the previous release is still serving. Fix the shell or the file and run the deploy again |
| Who put this site into "copy" mode? | — | **Admin → Audit Log**, action `ENVIRONMENT_SAFETY_OVERRIDE_UPDATED`. The entry names the administrator and the value before and after |
| A copy stopped raising Xero invoices, saying it cannot tell what installation this is | The role is *not configured*, and Xero writing fails closed until it is | Declare `APP_ENVIRONMENT_ROLE`, then re-drive the refused operations from **Admin → Xero**. Nothing was half-written |
| The **live site** stopped writing to Xero, and it *does* declare itself production | The role still resolves *not configured*, because the safer override could not be read from the database — deliberate fail-closed behaviour, since an administrator may already have forced this instance safer and there is no way to tell. Declaring the role again fixes nothing | Run `prisma migrate deploy` (or restore database access), then reload **Admin → Environment**. Xero writing resumes on its own |
| Xero contacts on our REAL organisation now hold `contained-…@xero-sandbox.invalid` | A copy was connected to the live Xero organisation, and containment did what it is for | Read the list on the copy's **Admin → Environment**, then follow "Putting a replaced address back" above — it is a manual per-contact repair in Xero, and the section says why no button can do it |
| We switched the safer override on to stop a copy touching Xero, and it got worse | That switch is what *starts* containment: it forces the installation to behave as a copy, and only a copy replaces addresses. It stops email to members, not Xero work | Disconnect Xero on that installation, or point it at a separate Xero organisation. Then repair the contacts as above |
| A copy will not import a Xero contact as a member | That contact's address has been contained, so a member made from it could never receive anything | Do the import on the live site |
| Admin → Environment says the contained count **could not be counted** | The database migration for this release has not been applied here | Run `prisma migrate deploy` (or `npm run db:migrate` in development) and reload |

## Related links

- Back to the [documentation hub](../README.md).
- Configuration reference: [`CONFIGURATION.md`](../../CONFIGURATION.md) →
  "Environment Role".
- The rules this implements: `INV-CONFIG-003`, `INV-CONFIG-004` and
  `INV-CONFIG-005` in
  [`product-configuration.md`](../invariants/product-configuration.md).
- Where the Xero containment sits in the Xero subsystem:
  [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md) -> "Contact email containment
  on a copy".
- Sibling setting recorded in the app rather than the environment:
  [Club Time Zone](club-time.md).
