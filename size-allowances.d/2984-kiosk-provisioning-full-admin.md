# File-size allowance for the #2984 kiosk-provisioning follow-through

file: src/app/api/admin/lodge/route.ts
lines: 488
reason: this file was already 462 lines against a 250-line route-handler
  budget — 1.8x over — before this change touched it. The change adds twenty-six
  lines, of which about six are the fix itself (gate the create on Full Admin,
  skip the access-role reconciliation when there is no account, return a null
  account instead of crashing) and the rest is the docblock explaining why the
  read and the create are gated differently. That explanation is the point
  rather than decoration: the defect being fixed existed precisely because one
  handler stated the separation-of-duties rule and its neighbour silently did
  not follow it, with nothing written down next to the second one to say why it
  should. Trimming the reasoning to save lines would recreate the conditions for
  the bug. Splitting a 488-line route handler is a worthwhile refactor and a
  poor thing to attempt inside a security fix — it would move three verbs and
  their shared serializers across files while the diff under review is meant to
  be small enough to check by eye. The module is over budget independently of
  this pull request and stays over it by the same margin plus twenty-six.
