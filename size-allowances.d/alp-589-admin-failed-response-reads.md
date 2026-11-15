# File-size allowances for ALP-589

Each file grows by the few lines it takes to check `res.ok` before parsing a
refusal and to give a dropped connection its own fallback (#4976). Splitting
any of these screens to absorb that would move one handler's error read away
from the handler, which is the drift the shared reader exists to stop.

file: src/app/(admin)/admin/booking-desk/waitlist/page.tsx
lines: 1034
reason: the force-confirm handler reads a refusal through the shared reader
  and keeps its unverified-outcome copy for an unreadable one, beside the
  capacity write it guards; the page's split is its own refactor.

file: src/app/(admin)/admin/finance/reports/page.tsx
lines: 777
reason: the report load reads a refusal through the shared reader and
  drops a stale reply in place; splitting the page shell for five lines
  would part the read from the request sequence it checks.

file: src/app/(admin)/admin/finance/subscriptions/page.tsx
lines: 853
reason: the Xero sync and manual-payment handlers parse only a success and
  read a refusal through the shared reader; splitting the page for four
  lines would move the handlers away from their state.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1453
reason: the leader writes read a refusal, including its capacity and
  amendment details, through the shared reader inside each handler; splitting
  the page is a separate refactor.

file: src/app/(admin)/admin/membership/member-applications/_components/approval-mapping-panel.tsx
lines: 738
reason: the preview and search reads check ok before parsing, one line more;
  splitting the panel for one line would scatter its two fetches.

file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 819
reason: the five officer actions check ok before parsing, one line more;
  splitting the page for one line would scatter its handlers.

file: src/app/(admin)/admin/rules/promo-codes/promo-codes-page-client.tsx
lines: 1769
reason: the promo-code save and delete name their fallback once and read a
  refusal through the shared reader inside each handler; splitting the
  client is a separate refactor.

file: src/app/(admin)/admin/website/image-manager/image-manager-client.tsx
lines: 748
reason: each dialog action names its own fallback beside the dialog modes it
  belongs to; splitting the client would part the map from its modes.
