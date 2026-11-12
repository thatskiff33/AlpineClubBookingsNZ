# Communications

Audience: Operator

## What it is

A one-off bulk email tool: write a plain-text message, pick a recipient group,
and send it to members — with a send history of what went out before. Each
message is either a **club notice** or a **club newsletter**, and the kind
decides which members receive it (#4987):

- A **club notice** is club business — AGM notices, lodge closures,
  subscriptions due. It goes to every member in the group except those who
  turned off **Club notices** on their profile. Members who never saved their
  preferences receive it.
- A **club newsletter** is optional club news. It goes only to members who
  turned on **Club newsletters** on their profile.

Find it at **Admin → Members → Communications**
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

2. Enter a **Subject** (up to 200 characters) and choose **Recipients** — *All
   Active Members*, *Members Only*, or *Admins Only*.
3. Under **Kind of message**, choose **Club notice** or **Club newsletter**.
   Nothing is chosen for you, and **Send to Members** stays disabled until you
   choose.
4. Read the recipient count under the choice, for example *Will be sent to 398
   of 400 members (2 opted out).* It is worked out the same way as the send, and
   changes when you change the recipients or the kind of message.
5. Write the **Message Body** (plain text, up to 10,000 characters — any HTML is
   escaped for security).
6. Click **Send to Members**. The confirmation says how many members it was sent
   to, and how many were left out because they **opted out** (turned the
   preference off) or **never opted in** (never turned Club newsletters on).
   Sending is **rate limited** (by default one send per hour).

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Subject | The email subject line | empty | Required; max 200 characters |
| Recipients | The audience group | All Active Members | *All Active Members*, *Members Only*, or *Admins Only* |
| Kind of message | Club notice (opt-out) or Club newsletter (opt-in) | none | Required; decides which members receive it |
| Message Body | The plain-text body | empty | Required; max 10,000 characters; HTML is escaped |
| Send to Members | Sends the message | — | Requires membership **edit** and a kind of message; rate limited (default 1/hour) |

The **Send History** table lists each past send: date, subject, recipient
filter, total recipients matched, and how many were actually sent (eligible
after preference filtering).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No **Communications** entry in the sidebar | The Communications module is off | Turn it on in [Modules](modules.md) |
| **Send to Members** is disabled | Your role has membership view, not edit, or the subject, body or kind of message is missing | Fill all three; ask a full admin for membership edit access |
| Far fewer recipients than expected | You chose **Club newsletter**, which reaches only members who turned Club newsletters on | If it is club business, send it as a **Club notice** instead; the count shows how many never opted in |
| A member still got a club notice after turning off newsletters | Club notices and Club newsletters are separate preferences | Expected — they turn off **Club notices** to stop club notices |
| Send rejected as rate limited | You already sent within the hour window | Wait for the window to clear (default one send per hour) |
| A member says the formatting was lost | The body is plain text; HTML is escaped | Send plain text; use [Email Messages](email-messages.md) for templated system email |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling comms guides: [Notifications & Email](notifications.md),
  [Email Messages](email-messages.md),
  [Email Deliverability](email-deliverability.md).
- Reference: member records and email preferences in [Members](members.md); the
  module toggle in [Modules](modules.md); the rule itself is
  [`INV-PRIV-023`](../invariants/analytics-and-privacy.md#inv-priv-023).
- A notice emailed on publish is a club notice: [Member Notices](member-notices.md).
