# Lodge Maintenance

Audience: Operator

## What it is

The place where reported faults at the lodge — a leaking shower, a broken heater,
a missing key — arrive, and where you deal with them. Members report from their
account; anyone at the lodge can report from a printed **QR sign** on the wall
without signing in, if you switch that on. Find it at `/admin/maintenance-reports`
(**Admin → Lodge Operations → Lodge Maintenance**).

Lodge Maintenance is a **lodge** permission area: lodge view to read the queue and
the questions, lodge **edit** to triage a report, delete a photo, edit the
questions, manage the signs, or change the settings. The page appears only when
the `maintenanceReports` module is on (it is **on by default**).

The page has four tabs:

- **Reports** — the queue of reported faults. Triage them here.
- **Questions** — the short, club-wide set of questions the form asks.
- **Signs** — the printable QR sign for each lodge.
- **Settings** — photos, how long they are kept, and the anonymous-QR switch.

## When you'd use it

- A fault has been reported and you need to see it, chase it, and mark it done.
- You want to change what the report form asks.
- You want a printed sign in the lodge so guests can report faults without an
  account.
- You want to turn photos on or off, change how long they are kept, or open (or
  close) the anonymous QR path.

## Step-by-step

### Deal with reported faults (Reports tab)

1. The queue opens on **Open** reports across every lodge. Use the **Status**,
   **Lodge**, and **Came from** filters to narrow it.
2. Each row shows the lodge, a one-line summary, who reported it, and badges for a
   QR-code report or an attached photo.
3. Click **Open** to read the full report — the answers as they were asked, and the
   photo (fetched only when you open it, so the list stays fast).
4. Move it along: **Working on it**, **Mark resolved** (optionally with a note of
   what was done), or **Reopen**. You can **Delete the photo now** at any time.

> A report from a member carries a verified account. A report from a QR sign shows
> whatever a stranger typed, labelled "says they are …" — never treat it as an
> identity the club has checked.

### Edit what the form asks (Questions tab)

1. Click **Edit**. The form always asks *what needs fixing* and *which lodge*, and
   offers a photo; the questions here are extra, asked at both doors in this order.
2. **Add a question**, set its wording, answer type (short text, longer text, yes/no,
   or one-of-a-list), optional help text, and whether it must be answered. Reorder
   with the arrows, or **Remove** one.
3. Click **Save**. Removing a question stops it being asked from that moment;
   reports already sent keep their answers and the wording they were asked under.

### Print a QR sign (Signs tab)

1. Each active lodge has a row. Click **Create sign** (or **Replace**). The code and
   a **Print sign** button appear **once** — print it now, or **Copy link**.
2. **Print sign** opens a ready-to-pin page with the QR code and a short
   instruction. Put it up in the lodge.
3. If you lose the printout, click **Replace**: it makes a brand-new code and the
   old one stops working immediately. **Pause** only switches a sign off
   temporarily — the same code works again when you resume it, so it does not help
   with a lost sign.

Signs only accept reports while the anonymous-QR switch in **Settings** is on.

### Change the settings (Settings tab)

1. Click **Edit** to change whether a photo may be attached, whether the QR path may
   attach one, how many days photos are kept, whether QR reporters are asked for a
   name and contact, and — the one that opens a public door — whether people can
   report from a QR code without signing in.
2. Click **Save**.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Report from a QR code without signing in | Whether the anonymous QR page accepts reports at all | **off** | Opens a page on the public internet. Each lodge's code is long and unguessable, rate-limited, and grants nothing but reporting a fault at that one lodge. Turning the module on does **not** open this — it is a separate switch |
| Allow a photo to be attached | Whether the form offers a photo | on | Photos are resized in the browser and stored with the report |
| Allow a photo from the QR code too | Whether the anonymous door may attach a photo | on | Meaningless (and disabled) while photos are off entirely |
| Delete photos after this many days | The photo-retention window | 30 | 1–365. Only the **photo** is removed; the report is kept for ever. Changing it affects photos sent from then on, not ones already stored |
| Ask QR reporters for a name and contact detail | Whether the QR form shows an optional contact prompt | off | Always optional for the reporter, and never checked against your membership list |
| Questions | The extra questions both doors ask | none | Club-wide, bounded (label, type, required, help, choices); answers store the question text as asked |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The page 404s / the sidebar entry is missing | The `maintenanceReports` module is off | Enable it under **Admin → Setup → Modules** |
| Everything is read-only | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| A QR sign shows "This code is not working" | The sign is paused, replaced, or the anonymous switch is off | Check the **Signs** tab and the anonymous switch in **Settings** |
| I lost the printed sign | The code is only shown once | Click **Replace** to make a new one; the old one stops working |
| A member can't find the photo they attached | The retention window passed and the photo was deleted | The report is still there; only the photo is removed after the retention days |
| The QR page never shows the token or an account | By design | The anonymous page reveals nothing about anyone's account and never displays the code — a stranger can only report a fault |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Lodge Kiosk](lodge.md), [Lodge Instructions](lodge-instructions.md),
  [Hut Leaders](hut-leaders.md), [Work Parties](work-parties.md),
  [Food Orders](food-orders.md).
- Reference: lodge scoping in
  [Lodge Scoping Contract](../multi-lodge/lodge-scoping-contract.md); the QR bearer
  token in [`SECURITY.md`](../SECURITY.md).
