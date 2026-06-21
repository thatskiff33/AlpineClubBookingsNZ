# UX Flow Map

This is a first-pass journey map for review planning. Route names are based on
current docs and may need verification during a later UI/UX review.

| Persona or flow | User goal | Expected steps | Copy and next action needs | Failure, empty, pending states | Accessibility and manual test route |
| --- | --- | --- | --- | --- | --- |
| Anonymous visitor | Understand the club and start joining or booking | Visit `/`, read public pages, use contact/join links | Clear club identity, eligibility, support contact, and member login path | Holding page before setup, contact send errors, disabled modules | Keyboard nav and heading order on `/`, `/contact`, `/join` |
| Applicant | Apply for membership | Open `/join/apply`, submit personal/family/nominator details | Explain nomination and admin review sequence | Duplicate application, invalid nominator emails, pending nominations | Form labels/errors on `/join/apply` |
| Nominator | Confirm nomination | Open nomination link, sign in if needed, confirm | Explain who is being nominated and consequence of confirmation | Expired token, wrong account, already used token | Token route and signed-in confirmation page, to verify |
| New member | Finish first login and setup | Login, change forced password, verify profile/subscription status | Clear next action after approval and setup invite | Expired setup invite, forced password, missing membership invoice | `/login`, `/change-password`, `/dashboard` |
| Existing member booking | Book lodge nights | Choose dates/guests, review quote, handle waitlist or payment | Explain date-only nights, capacity, policies, and cancellation terms | No capacity, invalid stay, expired draft, policy violation | `/book`, `/bookings`, booking detail route |
| Payment selection | Pay by Stripe or Internet Banking/Xero where available | Choose payment option, confirm payment or invoice instructions | Distinguish card payment from Internet Banking invoice settlement | Payment failed, Xero unavailable, saved card failure, recovery pending | Payment step in booking flow, route to verify |
| Waitlist | Join or accept offered place | Join waitlist, wait for offer, accept before expiry | Explain offer expiry and next action | Offer expired, capacity changed, payment needed | Waitlist UI and emails, route to verify |
| Booking modification | Change dates/guests/promo | Open booking, request or perform allowed edit, settle delta | Explain locked nights, review requirements, delta settlement | Admin review pending, extra payment failed, refund/credit pending | Booking detail modify flow, route to verify |
| Cancellation/refund/credit | Cancel booking and understand settlement | Request cancellation/refund, review policy, see outcome | Explain refund versus member credit and timing | Ineligible cancellation, pending admin review, provider failure | Booking detail cancellation/refund route |
| Profile/family/dependents | Manage personal and family data | Open profile/family pages, edit details, invite/remove dependents | Explain login-capable adult versus dependent behavior | Pending family request, inherited email ambiguity | `/profile` and family routes, to verify |
| Membership cancellation | Request cancellation for self/family | Start request, collect participant confirmations, wait for admin | Explain account access, booking blockers, rejoin process | Pending participant, rejected, withdrawn, future booking blocker | Member cancellation route, to verify |
| Admin review | Review applications, cancellations, bookings, refunds | Open admin queues, inspect evidence, approve/reject | Show blockers, irreversible effects, audit trail, next queue item | Empty queue, stale pending, provider failure | `/admin/dashboard`, relevant queue pages |
| Admin recovery visibility | Find stuck states across domains | Open `/admin/stuck-states`, triage by severity/owner, follow target link | Keep payment, Xero, email, waitlist, bed-allocation, and lodge signals in one scan | Empty queue, disabled modules, provider queue failures, stale recovery states | `/admin/stuck-states`, `/api/admin/stuck-states` |
| Finance/Xero | Monitor accounting and reconcile provider state | Open finance/admin Xero pages, run safe syncs, review failures | Explain operational Xero versus finance Xero | Missing credentials, failed sync, wrong access level | `/finance`, `/admin/xero`, guarded role checks |
| Lodge/kiosk | Manage arrivals, departures, chores, lodge info | Open `/lodge`, sign in or PIN, update day operations | Show current date, accountable actor, safe sign-out | No access, stale PIN session, empty roster | `/lodge`, keyboard/touch target checks |

## Review Prompts

For every journey, verify the next action, failure state, pending state,
accessible form semantics, and destructive/financial-action explanation.
