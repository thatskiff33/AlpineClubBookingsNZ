# File-size allowances for #4514

file: src/lib/booking-delete.ts
lines: 753
reason: the draft route's 409 for a draft that financial history names must sit in the transaction that holds lock(1), before the audit write, beside the ownership checks it follows; the rule itself lives in booking-financial-history.ts and draft-booking-cleanup.ts.

file: src/lib/member-lifecycle-actions.ts
lines: 1765
reason: one member hard-delete blocker (journal debtor, a retained identity) belongs in MEMBER_DELETE_BLOCKER_SPECS beside every other durable-history blocker; the read lives in the member-money boundary.

file: src/instrumentation.node.ts
lines: 1720
reason: the draft-cleanup cron reports and logs the drafts it withheld in its existing run summary; splitting the cron registration file is a separate refactor.
