# Recipients

Audience: Operator

## What it is

A grid of your admin users, each with a set of checkboxes for the system
alerts they personally receive — new bookings, payment failures, refund
requests, Xero sync errors, the daily digest, and so on. It controls *who on the
team* is emailed when an alert fires, per admin. Find it at
**Admin → Setup & Configuration → Notifications & Email → Recipients**
(`/admin/notification-recipients`). It has no direct sidebar entry — open it from
the **Recipients** card on the Notifications & Email hub.

Every admin user is listed, not just Full Admins: Booking Officers, Membership
Officers, Treasurers and any custom access role your club has built all appear,
with their role name under their email address.

**Alerts follow the areas a role can edit.** Each alert belongs to one admin
area, and an admin is only offered — and only ever sent — the alerts for the
areas their access role can **edit**. A Booking Officer therefore starts with
the booking alerts switched on and sees the finance and membership ones greyed
out as *Not available*; a Treasurer gets the money alerts; a Full Admin can edit
every area, so they get everything, exactly as before.

**There is no per-person override.** An alert outside an admin's areas cannot be
switched on from this grid at all — the checkbox is greyed out and the save is
refused. Widening the alerts one person receives means widening their access role
in [Access Roles](access-roles.md), which is a deliberate trade-off: alerts are
requests to act, so the people alerted are the people who can act. If you want
someone told about refund appeals, give their role Finance edit access; if that
is more power than you want to hand over, ask a Full Admin to forward the alert
instead.

Recipients are edited under the **support** ("Support & System") permission
area: support **edit** can change them; a view-only support role sees the grid
but cannot edit. Because the grid lists every admin user's name, email address
and access role, seeing the grid at all also needs **Membership view** access or
Support & System **edit** access — every built-in admin role that can open this
page has one or the other, so this only affects a custom role you have built with
support view on its own. Within an admin's own areas, new alert types default to **enabled**, so they
receive everything for their areas until someone trims the list.

Delivery Rules sit **upstream** of everything on this page. If
[Delivery Rules](notification-rules.md) mute a template club-wide, nobody
receives it however their boxes are ticked here.

## When you'd use it

- A committee member is being flooded with alerts they don't handle and wants
  some switched off.
- A new treasurer should start receiving payment-failure and Xero sync alerts.
- You want one person (not the whole team) to own the daily digest.

## Step-by-step

### Adjust who receives which alert

1. Open **Recipients**. Each admin user is a card of alert checkboxes; the
   alerts outside their areas are greyed out and cannot be ticked.

   ![Recipients: one card per admin user, each showing checkboxes for the system alert types they receive](../images/admin/admin-notification-recipients.png)

2. Click **Edit** to make the checkboxes editable. Tick or untick each alert for
   each admin.
3. Click **Save Changes** (or **Cancel** to discard). Only the admins you
   actually changed are written.

## Settings reference

Each admin card has one checkbox per alert type. The **Area** column is the
permission area an admin's role must be able to **edit** before that alert is
offered to them at all:

| Alert | Area | Sent when |
| --- | --- | --- |
| New bookings | Bookings | A new booking is created or confirmed |
| Payment failures | Finance | A booking payment fails |
| Pending deadlines | Bookings | Bookings approach their pending deadline (digest) |
| Bookings bumped | Bookings | A pending booking is bumped by another booking |
| Xero sync errors | Finance | Xero contact or invoice sync fails |
| Capacity warnings | Bookings | Occupancy is nearing full capacity |
| Daily digest | Admin Overview | A daily summary of the previous 24 hours of admin alerts |
| Waitlist offers | Bookings | A waitlist spot is offered to a member |
| Member requests | Membership | A member submits a family-group / linking request |
| Booking change requests | Bookings | A member requests a change to a locked booking, or asks for a booking-policy exception |
| Refund requests | Finance | A member submits a refund appeal |
| Reported issues | Support & System | A logged-in user reports a site issue |
| Public booking requests | Bookings | A non-member submits a public booking request |
| Booking review required | Bookings | A booking needs admin review before confirmation |
| Member delete requests | Membership | A hard-delete of a member is requested (two-admin rule) |

### Always-on alerts

Four alerts are sent outside this grid. They have no checkbox anywhere and cannot
be muted — not here, and not in [Delivery Rules](notification-rules.md), because
their templates (`admin-email-failure`, `admin-late-capture-auto-refund`,
`admin-late-capture-hand-back-conflict`) are locked to always-send:

| Alert | Goes to | Sent when |
| --- | --- | --- |
| *An email to a member could not be sent* | Every admin whose role can **edit** Support & System | The system could not read a booking's "No emails" setting, so it withheld a member email rather than risk sending one that was meant to be held back |
| *Email delivery permanently failed* | Every admin whose role can **edit** Support & System | A member email has used up its automatic retries and will not be retried |
| *Payment refunded automatically — booking already deleted / already cancelled* | Every admin whose role can **edit** Finance | A member's payment landed after the booking had already been cancelled, so the charge was returned to them automatically. This happens for a booking's own payment and for a payment for a change to it, and the mail says which. Nothing failed and nothing is owed — the mail exists so the money movement is not invisible, and it names whether the booking was also deleted, in which case remaking it means charging the member again |
| *Automatic refund withheld — already paid back by hand* / *Payment may have been refunded TWICE — reconcile* | Every admin whose role can **edit** Finance | Somebody had already marked a hand-back task for that payment as paid back, which records the refund in the ledger. The automatic refund was withheld so the member is not paid twice — or, if the hand-back was recorded at the exact moment the refund was going out, it went as well and the two have to be reconciled. This is the one mail that may be telling you money left the club twice, which is why it cannot be switched off either |

The first two name the intended recipient's email address and the template that
failed, so they are operational detail rather than routine notification. The refund
notice is money moving without anybody deciding it, which is why a club cannot
switch it off; it is the same event the **"Refunded automatically — nothing to pay
back"** card on [Payments](payments.md) records. The fourth is the same money seen
from the other side — a refund deliberately not sent, or one sent twice — and
produces no card row at all, so the mail is the whole notice. The only way to change
who receives one of these is to change who holds the access it is sent to — Support &
System edit for the first two, Finance edit for the two refund notices, which for the
built-in roles means the Full Admins and the Treasurer.

If a club has nobody holding the area at all, the alert is not dropped: both refund
notices fall back to Support & System editors, and then to the club's own support
address — the one set in [Email Messages](email-messages.md), or the address in the
club's configuration if none is set — so it can never be sent to nobody.

Two things worth knowing about that fallback. It only happens when **no** role can
edit Finance, and while it lasts a Support & System editor receives the member's
name, stay dates, refunded amount and payment identifiers even if their role has no
Finance access at all — reaching somebody is treated as better than reaching nobody,
and each fallback step is logged. The fix is to give somebody Finance edit, which
takes the notices back to the intended audience.

Which means, out of the box:

| Role | Receives by default |
| --- | --- |
| Full Admin | Every alert |
| Booking Officer | All eight booking alerts, including booking change and exception requests |
| Membership Officer | Member requests and member delete requests |
| Treasurer | Payment failures, Xero sync errors, refund requests |
| Read-only Admin, Content Manager | Nothing — they cannot action any alert |
| Custom access role | Whatever its own editable areas cover |

| Rule | Detail |
| --- | --- |
| Default | Within an admin's own areas, new alert types default to **enabled**; alerts outside their areas are never sent |
| No override | An out-of-area alert cannot be enabled for an individual from this grid — change their access role instead |
| Scope | Every **active** admin user who can sign in appears — Full Admins, scoped officers and custom roles alike. Deactivating an admin, or turning off their login, removes them from the grid and from every alert |
| Upstream | [Delivery Rules](notification-rules.md) can mute a template club-wide; that wins over anything ticked here |
| Save granularity | Only changed admins are PUT; unchanged cards are left untouched, and if one admin's save is refused the others still save |
| Outside the grid | Two locked email-failure alerts go to Support & System editors, and the automatic-refund notice goes to Finance editors, regardless of anything ticked here — see *Always-on alerts* above |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The checkboxes won't tick | You haven't clicked **Edit**, or your role is support view-only | Click **Edit**; if still locked, request Support & System edit access |
| An admin isn't listed | They are inactive, cannot sign in, or hold no admin access role | Give them an admin access role, and reactivate or re-enable their login in [Members](members.md) |
| A committee member gets nothing | Every alert is unticked for them, or their role cannot edit any area that owns an alert | Tick the alerts they should own and Save; if the boxes are greyed out, widen their role in [Access Roles](access-roles.md) |
| An alert is greyed out as *Not available* | It belongs to an area their access role cannot edit. It cannot be ticked here for one person | Give the role edit access to that area in [Access Roles](access-roles.md), or assign the alert to someone who already has it |
| Nobody receives a particular alert | It is muted club-wide upstream | Check [Delivery Rules](notification-rules.md) for that template |
| Save failed with a permission error | The write route rejected a support-view session | Ask a full admin to make the change |
| One admin's card would not save but the rest did | That admin's save was refused on its own — usually a stale page whose role has since changed | Reload the page and redo just that card |
| The page opens but no admin cards are listed | Your role has Support & System view but no Membership view, so the roster is withheld | Ask a full admin to widen your access role, or to make the change for you |
| Someone still gets email-failure or automatic-refund alerts with every box unticked | Those alerts are locked and follow area edit access — Support & System for the email-failure pair, Finance for the automatic-refund notice | Remove that area's edit access from their role, or accept them — see *Always-on alerts* |

## Related links

- Back to the [documentation hub](../README.md).
- Hub: [Notifications & Email](notifications.md).
- Sibling guides: [Delivery Rules](notification-rules.md),
  [Email Messages](email-messages.md),
  [Email Deliverability](email-deliverability.md).
- Reference: admin roles and the admin team in [Members](members.md), and the
  permission areas behind each alert in [Access Roles](access-roles.md).
