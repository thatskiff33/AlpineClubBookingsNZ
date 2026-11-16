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
clearing a suppression, reissuing a token email — are **support**-area edit
actions; a view-only support role sees the figures but cannot act.

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
     retirement clears it by design. A failed booking confirmation, pre-arrival
     reminder or guest payment link shows a **Send a fresh copy from the
     booking** link instead — see below.
   - **Admin Alert Delivery** — admin alerts that had to escalate within the
     lookback window because no recipient received them at send time. A later
     retry may since have delivered one; the row records the send, not the
     outcome.

### Send a fresh copy of a booking email

The booking confirmation, the pre-arrival reminder and the guests' separate
payment link carry a door code or a single-use payment link, so the club never
keeps their body and a failed one is never retried. To get the member the
message anyway, send a **fresh copy** from the booking.

1. From the failure's **Send a fresh copy from the booking** link, or straight
   from the booking's page, open the **Send a fresh copy of a booking email**
   section. It lists the three emails, says how many earlier copies failed, and
   says why an email cannot be sent right now (for example "This stay has
   ended").
2. Choose the email's **Send fresh …** button and confirm. You choose only which
   email; you cannot change the address, the wording or any amount.
3. Read the result under the button. Only "Sent to …" means the member was sent
   it. Anything else — the booking's **No emails** switch, a suppressed or
   placeholder address, a copy of the site that does not email members — says
   nothing was sent and what to fix first.

What a fresh copy is:

- **Newly rendered, never recovered.** It is built from the booking as it is
  now: its current owner (an organisation's contact for an organisation
  booking), dates, party, price, payment state and the lodge's current door code.
- **A new payment link.** The guest payment link goes to the separate guest
  booking's owner, as it always does. Sending it makes a new link and the old
  one stops working; you cannot send another within a minute.
- **One at a time.** The same email cannot be sent again for the same booking
  within two minutes after a recorded send. This check does not reserve a send: two officers submitting at exactly the same time may both send a confirmation or reminder. Payment links use the existing locked one-minute cooldown.
- **Recorded only when sent.** A sent copy archives that email's earlier
  exhausted failures for the booking, with the reason "Superseded by a fresh copy
  sent from the booking", and writes a "Fresh copy of a booking email sent" row
  to the audit log, linking the new delivery log and the earlier failed copies. The failed rows themselves stay in the email log as history.
  A send that did not go out archives and records nothing.
  If the email was sent but its archive or audit write failed, the result warns
  you to check the delivery log before sending again.
- **The daily reminder still runs.** A pre-arrival reminder sent within the
  daily reminder's window counts as that reminder; one sent earlier does not, so
  the member still gets the usual reminder nearer the stay.

You need **Bookings** edit access to send. With view access the section shows
what failed but the buttons stay off. **Token Email Recovery** is unchanged and
still reissues sign-in and pay links from this page.

## Settings reference

This is a monitoring page — it has no configuration. The figures it shows:

| Section | Key figures | Action available |
| --- | --- | --- |
| Email Deliverability | Active suppressions (bounced/complained recipients) | Clear a suppression (support edit) |
| Token Email Recovery | Active / reissued / scanned counts, per-failure list | Reissue a token email (support edit) |
| Exhausted Email Failures | Active / reviewed / max attempts / scanned counts, plus each row's failure reason | Follow the displayed recovery instruction, then archive (support edit); for a booking confirmation, pre-arrival reminder or guest payment link, send a fresh copy from the booking (bookings edit) |
| Admin Alert Delivery | Recent escalations, lookback window (days) | — (informational) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A member never got any email | Their address is suppressed after a bounce/complaint | Confirm the address, then clear the suppression here |
| A pay or sign-in link never arrived | The tokenised email failed | Reissue it from **Token Email Recovery** |
| A booking confirmation, pre-arrival reminder or guest payment link failed and was not retried | It carries a door code or payment link, so no copy is kept to retry | Follow **Send a fresh copy from the booking** and send a fresh copy; the failure archives itself once the copy has gone |
| A failure says it was not retried because recipient authorization context predates #2362 | The legacy booking email was retired fail-closed; this is a security retirement, not three provider send attempts | Follow the displayed instruction: regenerate a fresh email through the current booking workflow, manually re-send it only if it is still needed, then archive the failure |
| The action buttons are greyed out | Your role has support view, not edit | Ask a full admin for Support & System edit access |
| Lots of exhausted failures at once | A provider outage or misconfiguration | Check email delivery config in [`../../CONFIGURATION.md`](../../CONFIGURATION.md#email-delivery); review then clear once resolved |
| Figures look stale | The page snapshots on load | Click **Refresh** |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Background Jobs](background-jobs.md), [Audit Log](audit-log.md).
- Comms hub: [Notifications & Email](notifications.md).
- Reference: email delivery configuration in
  [`../../CONFIGURATION.md`](../../CONFIGURATION.md#email-delivery) and the email
  section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).
