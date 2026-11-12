# Email Deliverability

Audience: Operator

## What it is

A monitoring page for what actually reached members: which recipients are
**suppressed** (bounced or complained), which sends need attention after
provider retry exhaustion or a fail-closed security retirement, whether
tokenised emails (sign-in, pay links) needed recovery, and whether admin alerts
had to escalate. It answers "did the email
get through?" where [Delivery Rules](notification-rules.md) answer "should it
have been sent?". Find it at **Admin → Monitoring & Support → Email Deliverability**
(`/admin/email-deliverability`).

It reads from the same data as [System Health](health.md) (it is the email
slice of that page) and refreshes on demand. The remediation actions on it —
clearing a suppression, reissuing a token email, trying a failed email again,
archiving a failure — are **support**-area edit actions; a view-only support role sees the figures but cannot act.

## When you'd use it

- A member says they never received a booking, payment, or password email.
- You want to check whether a bounced or complained address is being suppressed.
- After a provider outage, you want to see what failed and reissue the important
  tokenised emails.

## Step-by-step

### Investigate a delivery problem

1. Open **Email Deliverability**. Use **Refresh** (top right) to pull the latest
   figures; the last-refresh time is shown beside it.

   ![Email Deliverability: the Email Deliverability, Token Email Recovery, Exhausted Email Failures, and Admin Alert Delivery sections with their summary counts](../images/admin/admin-email-deliverability.png)

2. Read the four sections top to bottom:
   - **Email Deliverability** — active recipient **suppressions** (addresses the
     provider bounced or that complained). Clear a suppression once the address
     is known good.
   - **Token Email Recovery** — tokenised emails (sign-in / pay links) that
     failed and were scanned for reissue; reissue the ones a member still needs.
   - **Exhausted Email Failures** — sends that need operator attention. Most used
     every provider retry attempt, but a legacy booking email can instead be
     retired without another send when the worker cannot safely re-prove the
     recipient's authorization. Read the displayed **Failure reason** for the
     authoritative cause and next step. For a security retirement, regenerate a
     fresh email through the current booking workflow and manually re-send it
     only if the recipient still needs it. Complete that instruction before
     choosing **Archive**. Never recover or copy an old retained email body; the
     retirement clears it by design. What else a row offers is covered in
     [Deal with an exhausted email failure](#deal-with-an-exhausted-email-failure).
   - **Admin Alert Delivery** — admin alerts that had to escalate within the
     lookback window because no recipient received them at send time. A later
     retry may since have delivered one; the row records the send, not the
     outcome.

### Deal with an exhausted email failure

Each row in **Exhausted Email Failures** shows **Open booking** when the email
was about a booking that still exists (or *Booking no longer exists* when it was
deleted), and **Open member** when the email was addressed to a known member.
What you can do next depends on whether the system kept a copy of the message:

1. **The row has Try again.** The system still holds the message. Choose
   **Try again** and confirm. Nothing is sent straight away: the email goes back
   to the retry job, which sends it on its next run (usually within 30 minutes)
   after checking again that the recipient is not suppressed, that the booking's
   **No emails** switch is off, and that any link to the booking is still right
   for the recipient.
   If that one attempt fails too, the row comes back here. If someone else
   already pressed it, or the email has since gone out, you are told so; refresh
   the list.
2. **The row says it can't be resent from here.** The message held a sign-in
   link, a door code or a payment link, so no copy was kept, or its copy was
   cleared when it was retired. Use **Open booking** or **Open member** to send
   the member a fresh message, or, where the row says so, reissue it from
   **Token Email Recovery**. Then choose **Archive**.

**Archive and Try again together.** Both are recorded in the audit log, and
the newer of the two decides where a row shows. A row you archived and then
tried again shows as active if it fails again; a row tried again and then
archived stays archived.

**Totals.** **Total exhausted** counts every exhausted failure. The list itself
reads only the newest 200; when there are more, a note says so, and the active
and archived counts then cover only those 200.

## Settings reference

This is a monitoring page — it has no configuration. The figures it shows:

| Section | Key figures | Action available |
| --- | --- | --- |
| Email Deliverability | Active suppressions (bounced/complained recipients) | Clear a suppression (support edit) |
| Token Email Recovery | Active / reissued / scanned counts, per-failure list | Reissue a token email (support edit) |
| Exhausted Email Failures | Active / reviewed / total exhausted / max attempts / scanned counts, plus each row's failure reason, booking and member links | Try again when the row holds a copy of the message; otherwise follow the displayed recovery instruction; then archive (support edit) |
| Admin Alert Delivery | Recent escalations, lookback window (days) | — (informational) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A member never got any email | Their address is suppressed after a bounce/complaint | Confirm the address, then clear the suppression here |
| A nomination, account-setup or membership-cancellation email never arrived | The tokenised email failed | Reissue it from **Token Email Recovery** |
| A booking confirmation, door-code reminder or payment link never arrived | It keeps no copy, so it is listed under **Exhausted Email Failures** without **Try again** | Use the row's **Open booking** or **Open member** link to send the member a fresh message, then archive the failure |
| An email failed after a provider outage and the row has **Try again** | The retry job used all its attempts during the outage | Once the provider is working, choose **Try again**; the next retry run sends it |
| A failure says it was not retried because recipient authorization context predates #2362 | The legacy booking email was retired fail-closed; this is a security retirement, not three provider send attempts | Follow the displayed instruction: regenerate a fresh email through the current booking workflow, manually re-send it only if it is still needed, then archive the failure |
| The action buttons are greyed out | Your role has support view, not edit | Ask a full admin for Support & System edit access |
| Lots of exhausted failures at once | A provider outage or misconfiguration | Check email delivery config in [`../../CONFIGURATION.md`](../../CONFIGURATION.md#email-delivery); once resolved, try again the rows that offer it and archive the rest |
| The list says it shows only the newest 200 | More than 200 exhausted failures exist | Work through and archive the newest; **Total exhausted** is the true figure |
| Figures look stale | The page snapshots on load | Click **Refresh** |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Background Jobs](background-jobs.md), [Audit Log](audit-log.md).
- Comms hub: [Notifications & Email](notifications.md).
- Reference: email delivery configuration in
  [`../../CONFIGURATION.md`](../../CONFIGURATION.md#email-delivery) and the email
  section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).
