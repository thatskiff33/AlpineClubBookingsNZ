# Dataset Reset inventory

**Audience:** Developers and agents.

This inventory defines which admin and finance datasets participate in the
standard **Reset** contract. It records the decision before the behaviour is
changed, so future tables do not have to infer whether a control is dataset
state or navigation context.

Back to the [documentation hub](../README.md).

## Contract

A page-level table, list, queue, register, or report is included when its search,
filters, explicit sort, page, or page-size state survives ordinary interaction
with that dataset. The state may live in the URL or in React state. URL-backed
datasets use `router.replace` for query-only churn, through
`useAdminListUrlSync` so a page never replaces the address it is already on
(#5295), and preserve unknown query keys for forward compatibility.

The visible label is always **Reset**. It remains rendered at the true default
and is disabled only when search, dataset filters, explicit sort, page, and
page size are all at their defaults. Context is not part of the dirty check and
is not reset: lodge/member/record identifiers, the active tab or section,
season/cohort selectors, and unknown URL keys remain in place.

## Included datasets

| Surface | Persisted dataset state and true default | Preserved context |
|---|---|---|
| Members | Search empty; all filters empty; name ascending; page 1 | Unknown URL keys |
| Bookings | Search/date/status/month/deleted/payment/Xero/bed/change/consent/upcoming filters at their neutral values; default service sort; page 1 | `lodgeId`; unknown URL keys |
| Payments | All categorical, amount, check-in and search filters neutral; updated range is the rolling New Zealand day three months ago through today; last-updated descending; page 1 | Unknown URL keys |
| Subscriptions | Status, age group and Xero group are `all`; member ascending; page 1 | `seasonYear`; unknown URL keys |
| Audit Log | Event/category/member/date/outcome/severity/entity/search filters neutral; member scope `involves`; page 1 | Unknown URL keys |
| Reports | From the start of the month three months before the current NZ month through the end of the current NZ month; deleted `hide` | Selected lodge; local-state architecture remains local |
| Refund Requests | Status `PENDING` | Unknown URL keys |
| Waitlist | Dates empty; page 1; page size 25 | Unknown URL keys |
| Xero Operations | All operation filters neutral; page 1 | `section`; the sibling panel's keys; unknown URL keys |
| Xero Inbound Events | All inbound-event filters neutral; page 1 | `section`; the sibling panel's keys; unknown URL keys |
| Family Groups | Search/count filters empty; pending-only off | `edit`; unknown URL keys |
| Issue Reports | Status `OPEN`; page 1 | `report`; unknown URL keys |
| Deletion Requests | Status `PENDING`; both request lists on page 1 | Page route context |
| Membership Cancellations | Status `REQUESTED` | Page route context |
| Member Applications | Status `PENDING_ADMIN` | Page route context |
| Booking Requests - Approvals | Status `PENDING`, or `ALL` while a focused booking record requires that contextual default | `tab`, `bookingId`; unknown URL keys |
| Booking Requests - Changes | Status `REQUESTED`, or `ALL` while a focused request record requires that contextual default | `tab`, `requestId`; unknown URL keys |
| Booking Requests - Public | Status `QUEUE` | `tab`, `requestId`; unknown URL keys |
| Induction Register | Search empty; status neutral | Page route context |
| Promo Redemptions | Date and lodge filters empty; page 1 | Promo-code record; expanded rows are transient presentation |
| Lockers | Locker-name ascending | Selected lodge; create/edit form state is not dataset state |
| Finance Dashboard | Range `Last Month`; comparison `Previous Period`; forward window `Next Month`; expense category and line empty | Current `view`; `lodgeId`; Ratio Explorer inputs; unknown URL keys |

## Excluded state

| Surface or state | Decision |
|---|---|
| Member, contact, signer, custodian, and replacement-member searches | Excluded: transient typeaheads or pickers used to populate a form/dialog, not to shape a page dataset. |
| Dialog open state, row expansion, selected rows, drafts, notes, and confirmation choices | Excluded: transient interaction or ordinary form state. |
| Family-group `edit`, issue-report `report`, booking-request record keys, Xero `section`, subscription `seasonYear`, and page lodge selectors | Excluded from reset as navigation, record, tab/section, season/cohort, or lodge context. |
| Communications recipient selection | Excluded: an ordinary send form input; the history table is not filtered by it. |
| Setup wizards, command palettes, image/bed/contact pickers, and settings editors | Excluded: workflow navigation or form state rather than page-level dataset state. |
| Finance Ratio Explorer URL inputs | Excluded: calculator/chart configuration, not a page-level table or list dataset. |

## Maintenance rule

When a page adds persistent search, a dataset filter, explicit sort, or
pagination, update this inventory and add the always-visible Reset control in
the same change. Tests must cover isolated search/filter/sort/page dirty states,
combined state, disabled-at-default discoverability, and context/unknown-key
preservation where a URL is involved.
