# Export & Import (config transfer)

Audience: Operator

## What it is

A full-admin tool that exports your club's **configuration, site content, and
lodge setup** as a single portable `.zip` bundle, and imports such a bundle into
another (or the same) instance through a **preview → apply** flow. Ordinary
categories never delete; the booking-policy sets are the explicit exception and
are replaced as a complete set. Find it at **Admin → Setup & Configuration → Export & Import**
(`/admin/config-transfer`).

Only **Full Admins** can open this page (others see a "full administrators only"
notice). It is **not** a database backup: ordinary imports preserve anything
added since the export, while an omitted minimum-stay policy or hosting scope is
deleted after a
prominent preview. Members, bookings, payments, and other transactional data
are never included. The full contract — categories, validation rules, and safety
model — lives in the [config-transfer feature hub](../config-transfer/README.md).

## When you'd use it

- Cloning a configured club into a new environment (staging → production, or a
  fresh fork).
- Moving site content, lodge setup, or fee schedules between instances without
  re-entering them by hand.
- Taking a portable, human-editable snapshot of configuration to review or edit.

## Step-by-step

### Export a bundle

1. Go to **Admin → Setup & Configuration → Export & Import**.

   ![Configuration Export & Import page with the export category checkboxes and the import upload / dry-run panel](../images/admin/admin-config-transfer.png)

2. In **Export**, tick the categories to include. **Include lodge door codes** is
   an opt-in checkbox (physical-access information), off by default.
3. Click **Export bundle** to download `config-transfer-<date>.zip`.

### Import a bundle

1. In **Import**, choose a `.zip` file and click **Preview (dry-run)** — nothing
   is written yet. The plan shows, per entity, what would be **New**, **Updated**,
   **Deleted**, or **Unchanged**, plus any door-code, Xero-org, or edited-bundle
   warnings. Every changed or deleted row stays visible even in a long plan.
2. Pick a **write mode** — **Merge** (recommended; only fields with a value in
   the bundle are written) or **Overwrite** (the bundle fully defines each
   record; blank fields clear it). You can also untick categories or resolve a
   rename via its match picker; each change re-previews.
3. If validation shows **errors**, Apply stays disabled — fix the bundle, use
   **Reseal edited bundle** to regenerate its manifest, and re-preview. When the
   plan is clean, click **Apply import**: the server takes a `pg_dump` backup
   first, then applies in one transaction.

## Settings reference

Exportable categories:

| Category | Contains |
| --- | --- |
| Site content & appearance | CMS pages, keyed site content, club theme (embedded images travel in the bundle) |
| Club settings | Club-wide singletons: modules, booking defaults, member fields, club identity, email message settings, etc. |
| Booking policies | The complete club-wide and lodge-scoped minimum-stay policy set and the adult-member hosting setting for each scope, including whether each soft violation holds capacity or not |
| Lodge configuration | Lodges, rooms, beds, seasons, season rates, lodge instructions, chore templates, and each lodge's auto-allocation switch plus ordered allocation priorities |
| Committee (roles) | `CommitteeRole` definitions only (not member-linked assignments) |
| Induction checklists | Induction templates with their sections and items |
| Membership fees (joining & annual) | Joining-fee and annual-fee schedules with invoice-line components (integer cents) |
| Xero configuration | Xero account and item-code mappings |

| Control | Effect |
| --- | --- |
| Include lodge door codes | Opt-in; adds physical-access door codes to the export |
| Write mode: Merge / Overwrite | Merge patches only bundled fields; Overwrite makes the bundle authoritative (blank clears) |
| Categories to import | Untick to import a subset (re-previews) |
| Match picker | Resolve an unmatched season/chore/induction template as *create new* or *match existing* |
| Reseal edited bundle | Regenerate the manifest after hand-editing a bundle |

Ordinary categories **never delete**. Booking policies are the deliberate
exception: importing replaces the complete minimum-stay and adult-member hosting
sets, and every omitted
row appears as **Deleted** in the preview. The automatic pre-apply `pg_dump`
backup is the true rollback. Validation errors (bad dates, non-integer money,
invalid slugs, unknown keys, or a malformed policy CSV/header) **block** apply
until fixed. A valid header-only `booking-policies/minimum-stay.csv` or
`booking-policies/adult-member-hosting.csv` explicitly
clears the set; a blank or malformed file never does.

**Connected provider credentials never travel.** A bundle never carries the
Xero/Stripe/Google/backup secrets your club has connected — not the encrypted
values, and not even a note of which providers are configured. This is permanent
policy, so a club restored or cloned from a bundle comes up with no connected
providers and you re-enter them there. See the
[config-transfer reference](../config-transfer/README.md#implemented-categories)
for the exact exclusion.

### Settings your club has never saved

A club-wide setting you have never opened and saved still has a value — the
built-in default the software runs on. Those settings **do travel** in a bundle:
the export writes the built-in defaults in place of the setting you never saved,
so importing the bundle moves the source club's settings across rather than
quietly leaving the target club's own values in place.

Three consequences worth knowing:

- **Importing creates the settings record**, even for a setting nobody ever
  configured. On the target club, **Admin → Setup** will then count booking
  defaults, group discount, membership cancellation, and module controls as
  *configured* or *checked*. The values are the same defaults it was already
  using — only the "has this been reviewed?" signal changes. Review those four
  steps after an import.
- **A default that ships changed in a later release no longer reaches that
  club**, because the value is now written down rather than resolved fresh each
  time. Change it deliberately in the admin if you want a different value.
- **The group-discount card's Save button** is greyed out on an untouched card
  after an import. Before, an unsaved group-discount setting left Save enabled
  so you could create the record; the import has now created it. Change a value
  and Save works as normal.

Bed-allocation settings also travel inside each lodge's folder as
`bed-allocation-settings.json`. The lodge slug identifies the target; source
database ids do not travel. An explicit empty `allocationPriorityOrder` is not
blank — it deliberately restores neutral deterministic ordering in both Merge
and Overwrite modes. Older settings files that omit only this newer field are
accepted and restore the historical order (keep the booking together, then
stay continuity, requested room, and direct-family cohesion). Invalid or
duplicate priority names stop the preview. If an older per-lodge file omits the
auto-allocation switch, an existing target keeps its switch in both modes; a
new target receives the built-in on default. If the whole per-lodge settings
file is absent, that lodge's existing row is left alone.

Club identity and email message settings work slightly differently. Their fields
— club name, short name, hut-leader label, Facebook URL, support and contact
addresses, public URL — are optional overrides on top of the values in the
install's own configuration file. When the source club **has** set them they are
exported and imported like any other setting, so a transfer does move the
source's club name and addresses onto the target; that is intended, and it is
why applying a bundle refreshes the club identity straight away. It is only when
the source club has never set any override that the bundle carries "no override"
rather than the source install's own fallback identity, and in that case the
import leaves the target's identity alone entirely — in **Overwrite** mode it
will clear an existing target override, but it never creates an identity record
where there was none.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "available to full administrators only" | You aren't a Full Admin | Ask a Full Admin to run the transfer |
| Apply is disabled | The plan has validation errors | Fix the named rows, **Reseal**, and re-preview |
| Errors naming a legacy `isMember` column or an `ENTRANCE_FEE` item-code row, with Apply disabled | The bundle was exported by **v0.12.2 or earlier** — that bundle shape is no longer imported | Re-export the bundle from the source install if it is still running the current release; otherwise hand-fix the columns as below, **Reseal**, and re-preview |
| `item-code-mappings.csv` error: "a HUT_FEE item-code row must name a membership type" | A hand-authored (or hand-edited) HUT_FEE row left `membershipTypeKey` blank | Fill in the membership type key — the exporter always emits one — then **Reseal** and re-preview |
| A fresh install came up **unconfigured** and the logs say nothing was written | The boot-time bundle at `CONFIG_BUNDLE_IMPORT_PATH` failed validation, so the auto-import refused (`refused-invalid`) and wrote nothing — a legacy bundle is the usual cause | Read the boot log line, which names the first validation error; replace the file with a current-shape export (or hand-fix and reseal it) and reboot, or import the bundle interactively on this page |
| "This bundle was edited since export" warning | Manifest checksums don't match the files | Advisory only — apply anyway, or **Reseal** to refresh the manifest |
| Xero org mismatch warning | The Xero config came from a different connected org | Verify the codes, or untick the Xero category before applying |
| A door-code change warning appears | The bundle would set/change a lodge door code | Confirm it's intended before applying |
| A "restore" didn't remove stale rows | Ordinary categories never delete; only the booking-policy sets are replaced | Remove stale ordinary rows on the owning admin page; the backup is the true rollback |
| An older bundle is refused | The current app requires exact config-transfer format version 4: booking-policy replace semantics are destructive, and version 4 added a second required file to that category | Re-export from the current app; resealing an older bundle does not upgrade its meaning |

### Converting a legacy bundle by hand

If the install that produced an old bundle is gone and all you hold is the zip,
you do not have to abandon it. Bundles are plain CSVs in a zip and are meant to
be edited: unzip it, make the three substitutions below, re-zip it, upload it,
click **Reseal edited bundle** to regenerate the manifest, and re-preview. The
old shape used a `true`/`false` "is this a member?" column where the current
shape names the **membership type** directly.

| File | Old column / value | Change it to |
| --- | --- | --- |
| `lodge-config/lodges/<slug>/season-rates.csv` | `isMember` column, `true` | a `membershipTypeKey` column with `FULL` |
| `lodge-config/lodges/<slug>/season-rates.csv` | `isMember` column, `false` | a `membershipTypeKey` column with `NON_MEMBER` |
| `xero-config/item-code-mappings.csv` (HUT_FEE rows) | `isMember` column, `true` / `false` | a `membershipTypeKey` column with `FULL` / `NON_MEMBER` |
| `xero-config/item-code-mappings.csv` | `category` value `ENTRANCE_FEE` | `JOINING_FEE` (the same rows, renamed) |

Practical notes:

- **Rename the header, not just the values.** Replace the `isMember` header cell
  with `membershipTypeKey` and rewrite each row's `true`/`false` to `FULL` /
  `NON_MEMBER`. A row that still carries an `isMember` value with no
  `membershipTypeKey` is what triggers the rejection.
- `FULL` and `NON_MEMBER` are the built-in membership type **keys**. If your club
  renamed or replaced them, use the keys shown on **Admin → Membership Types** —
  an unknown key is its own clear row error.
- Leave `JOINING_FEE` rows' `membershipTypeKey` **blank**; that column keys
  HUT_FEE rows only.
- The dry-run is safe to repeat as often as you like — nothing is written until
  you click **Apply import** — so fix, reseal, re-preview, and iterate until the
  plan is clean.

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Configuration Export & Import](../config-transfer/README.md).
- Sibling guides: [Setup](setup.md), [Modules](modules.md),
  [Site Content](site-content.md), [Xero Sync](xero.md).
- Reference: the pre-apply backup and DR flow in [`DEPLOYMENT.md`](../../DEPLOYMENT.md).
