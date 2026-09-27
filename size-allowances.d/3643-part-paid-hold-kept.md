# File-size allowances for #3643 — part-paid hold kept

The hold-expiry job now keeps a hold with money against its invoice and tells
the treasurer once. The alert is a new admin email, and every admin email is
registered in the one template registry.

file: src/lib/email-message-registry.ts
lines: 2097
reason: the new admin-internet-banking-hold-kept alert has to be registered
  where every other template is — its admin audience, its required tokens,
  its trigger summary, its approved composed token and that token's preview
  sample are each one entry in an existing table, and a second registry would
  split the one list the editor, the delivery rules and the censuses all read.
