# Issue Reports

Audience: Operator

## What it is

The triage queue for problems members report from the site's floating
"Report issue" widget. Each report captures the page, the member's description,
and (with consent) a screenshot and browser info; you review it, resolve or
reopen it, and delete a retained screenshot once you're done. Find it at
**Admin → Monitoring & Support → Issue Reports** (`/admin/issue-reports`) — it also surfaces in the
sidebar's **Needs Attention** section while reports are open.

Issue reports are handled under the **support** ("Support & System") permission
area: a support-**edit** admin can resolve, reopen, and delete screenshots; a
support-**view** admin can browse but not act. See [`ARCHITECTURE.md`](../ARCHITECTURE.md)
(issue reports / stuck states) for the model.

**One exception, and it is about screenshots only.** A picture taken by somebody
who had admin access is shown only to a **Full Admin**. See
[Screenshots taken by an officer](#screenshots-taken-by-an-officer) below for
what you see instead and why.

## When you'd use it

- A member hit a bug and reported it, and you want to see what they saw
  (including their screenshot).
- You're clearing the open-reports queue and marking fixed issues resolved with
  a note.
- A retained screenshot has served its purpose and should be deleted for privacy.

## Step-by-step

### Review and resolve a report

1. Go to **Admin → Issue Reports**. Filter by **Open**, **Resolved**, or
   **All**. Each row shows the page title, status, whether a screenshot is
   retained, the description, and who reported it when. **Reset** restores Open
   and page 1 without closing or changing a report selected through the URL.

   ![Issue Reports queue with the status filter and a list of member-submitted reports showing status and screenshot badges](../images/admin/admin-issue-reports.png)

2. Click **View** to open the report: the member, submission time, page link,
   full description, the screenshot (if retained), and browser info.
3. Add a **Resolution note** (up to 1000 characters) and click **Resolve** — or
   **Reopen** a resolved one. Use **Delete** on a retained screenshot to remove
   it once it's no longer needed.

### Screenshots taken by an officer

Support access can be handed out on its own: an officer can be given it to work
the issue-report queue without being given any access to member records. That is
the point of a separate permission area, and it is also where a screenshot can
quietly go around it — an admin screen shows member names, addresses and dates of
birth, so a picture of one hands over exactly the details the club chose not to
share.

So the system records, when a report is filed, whether the person filing it had
admin access at the time. If they did, the picture is treated as possibly showing
another member's record and **only a Full Admin can open it**. The rule is
written down once, as `INV-PRIV-020`.

What you see if you are not a Full Admin:

- the report itself in full — description, page, browser info, who reported it
  and when — and every action you already had;
- a **Screenshot withheld** badge in the queue and on the report;
- a short explanation in place of the picture, rather than a blank frame;
- the **Delete** button still available, because deleting a screenshot reduces
  what is stored and is worth doing whether or not you can see it.

Pictures attached by an ordinary member are not affected and are shown to
everyone with support access, exactly as before.

Two things worth knowing:

- **It goes by the reporter, not by the page.** An officer who reports a problem
  on an ordinary member-facing page still has their screenshot withheld. The
  page address a browser reports is something the browser sends, so it cannot be
  trusted to decide who may see a picture; the reporter's own access can be, and
  is checked on the server. Erring this way withholds a few harmless pictures
  rather than releasing a sensitive one.
- **Reports filed before this feature existed carry no record**, so they are
  withheld from everyone but a Full Admin. There is no way to work out after the
  fact who took them. They clear on their own within a month, because screenshots
  are deleted automatically after 30 days.

If you genuinely need a withheld picture, ask a Full Admin to look at the report
— every time a report is opened is recorded in the audit log either way, and so
is every refusal.

## Settings reference

The page has no configurable settings. What each report carries:

| Field | Meaning |
| --- | --- |
| Status | Open or Resolved |
| Page | The page title and URL the report was filed from |
| Description | The member's free-text description |
| Screenshot | Retained, withheld, deleted, or none — retained ones have an expiry and can be deleted manually. "Withheld" means it was taken by somebody with admin access and needs Full Admin to view |
| Browser info | Retained browser details (or "not retained") |
| Member | Who submitted it, and when |
| Resolution note | Your note on how it was resolved (max 1000 characters) |

Screenshots and browser info are retained only with consent and **expire
automatically**; you can also delete a retained screenshot during triage.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Resolve/Reopen/Delete buttons are inert | Your role has support **view**, not **edit** | Ask a full admin for support edit access |
| A report has no screenshot | The member didn't consent, it wasn't retained, or it expired | Work from the description and page URL |
| "Screenshot withheld" instead of the picture | It was taken by somebody with admin access, so it may show another member's record | Ask a Full Admin to view it, or work from the description |
| Every older report says "Screenshot withheld" | Reports filed before this feature carry no record of who took the picture, so the cautious answer is used | Expected — they expire within 30 days |
| "No issue reports found" | The status filter excludes them | Switch the filter to **All** |
| An old screenshot vanished | It reached its retention expiry | Expected — retained media expires automatically |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [Stuck States](stuck-states.md),
  [System Health](health.md), [Audit Log](audit-log.md).
- Reference: issue reports / stuck states in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
