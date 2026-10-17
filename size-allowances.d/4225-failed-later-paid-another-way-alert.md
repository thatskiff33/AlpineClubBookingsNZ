# File-size allowances for #4225 (#4210)

file: src/lib/email-message-registry.ts
lines: 2344
reason: twenty-one lines on a 2323-line registry that is not restructured here -
  one message entry, the card refund that failed after it was paid back another
  way, in each of the registry's lists (admin audience, delivery lock, required
  tokens, trigger summary), its preview sample and its one approved token. The
  registry is by construction one entry per message in one file, and it is what
  the token contract and the admin editor's validator classify from, so an entry
  has nowhere else to go. The alert must be delivery-locked: it is the one mail
  that stops a member who was already paid back by a close being paid again.
