# Communications

Audience: Operator

## What it is

A one-off bulk email tool: write a plain-text message, pick a recipient group,
and send it to members — with a send history of what went out before. It
respects members' notification preferences, so only those who opted in to
marketing email actually receive it. Find it at **Admin → Members → Communications**
(`/admin/communications`).

Communications is gated by the **Communications** module (Admin → Modules),
which is on by default — if the sidebar entry is missing, that module is off.
Sending is a **membership**-area edit action: a view-only membership admin sees
the page but the **Send to Members** button is disabled.

## When you'd use it

- You want to email active members about an event, closure, or club notice.
- You need to reach admins only (or members only) with a quick announcement.
- You want to confirm what bulk emails have already been sent, and to how many
  recipients.

## Step-by-step

### Compose and send a bulk email

1. Open **Communications**. Fill in the **Compose Message** card.

   ![Communications: the Compose Message card with Subject, Recipients dropdown, and Message Body, above the Send History table](../images/admin/admin-communications.png)

2. Enter a **Subject** (up to 200 characters) and choose **Recipients**. The
   line under the selector says who the choice reaches (see
   [Audiences](#audiences)).
3. Write the **Message Body** (plain text, up to 10,000 characters — any HTML is
   escaped for security).
4. Click **Send to Members** (pressing Enter in the Subject does the same).
   Nothing is sent yet: the page counts the people the audience reaches who
   opted in to marketing email, and asks you to confirm. The question names the
   number, the audience and the subject, for example *Send this email to 312
   people?*
5. Check them, then click **Send to 312 people** (the button repeats the
   count). **Cancel**, Escape, or Enter straight away all send nothing; Cancel
   has the focus when the question opens. If nobody in the audience has opted
   in, or the count cannot be read, the page says so and offers no send.
6. The result, how many were sent and how many were filtered out by
   preference, appears under the button and is announced to screen readers.
   Sending is **rate limited** (by default one send per hour), so a correction
   cannot follow straight away. Checking the count does not use up the limit.

### Audiences

| Recipients | Who it reaches (active accounts only) |
| --- | --- |
| All Active Members | Every active account, including admin, lodge, school and non-member booking contact accounts |
| Members Only | Ordinary member accounts. Accounts with the Full Admin role are not included. Accounts on other admin roles, such as Membership Officer or Treasurer, are. So are committee members unless they also hold the Full Admin role, because a committee position gives no admin role |
| Admins Only | Full Admin accounts only. Officers on other admin roles are not reached |

In every audience, only people who opted in to marketing email receive it.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Subject | The email subject line | empty | Required; max 200 characters |
| Recipients | The audience group | All Active Members | *All Active Members*, *Members Only*, or *Admins Only*; see [Audiences](#audiences) |
| Message Body | The plain-text body | empty | Required; max 10,000 characters; HTML is escaped |
| Send to Members | Asks you to confirm the audience, count and subject, then sends | — | Requires membership **edit**; only marketing-opted-in members receive it; rate limited (default 1/hour) |

The **Send History** table lists each past send: date, subject, recipient
filter, total recipients matched, and how many were actually sent (eligible
after preference filtering).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No **Communications** entry in the sidebar | The Communications module is off | Turn it on in [Modules](modules.md) |
| **Send to Members** is disabled | Your role has membership view, not edit (or subject/body is empty) | Fill both fields; ask a full admin for membership edit access |
| Far fewer recipients than expected | Only members who opted in to marketing email receive it | Expected. The confirmation counts only people who opted in; the result shown after the send says how many opted out |
| *Nobody in "…" has opted in to marketing email* | No active account in the chosen audience has opted in to marketing email | Choose another audience, or check members' preferences |
| *Could not check how many people would receive this email* | The recipient count could not be read, so the page would not send | Try again; nothing was sent and the hourly limit is untouched |
| Send rejected as rate limited | You already sent within the hour window | Wait for the window to clear (default one send per hour) |
| **Send history could not be loaded** | The history could not be read: an outage or a dropped connection. A send you just made is not undone by this | Press **Try again** before sending again, so you can see whether it went out. If it keeps failing, tell your club administrator |
| A member says the formatting was lost | The body is plain text; HTML is escaped | Send plain text; use [Email Messages](email-messages.md) for templated system email |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling comms guides: [Notifications & Email](notifications.md),
  [Email Messages](email-messages.md),
  [Email Deliverability](email-deliverability.md).
- Reference: member records and marketing opt-in in [Members](members.md); the
  module toggle in [Modules](modules.md).
