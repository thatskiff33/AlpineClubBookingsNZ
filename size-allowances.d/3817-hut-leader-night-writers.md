# File-size allowances for #3817 (hut-leader writers claim only stayed nights)

Two already-oversized hut-leader files grow by a few lines each. The rule they
implement (`INV-DATE-030`) lives in `src/lib/hut-leader-stayed-nights.ts`; what
remains here is the call at each decision point and the response it renders.

file: src/app/api/admin/hut-leaders/route.ts
lines: 447
reason: the stay check has to be asked twice, once cheaply before the lock and
  once under the lodge capacity key on the transaction client, exactly like the
  overlap check beside it, and its refusal has to be mapped to a 409 in the
  catch. The custodian tick adds its parse, its write, its audit field, the
  list field the table reads, and the module flag the page needs to stop
  offering a bed while bed allocation is off. The review round added the
  custodian-predicate composition, the minor warning keyed on it, and the
  post-commit "also a guest here" advisory note. The query, the refusal and the
  thrown error all live in the shared
  module; splitting the create handler around a two-call change would scatter
  one locked flow across files without shortening it.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1427
reason: the owner's refusal offers "Change last night to …", so the page has to
  carry the corrected end date from the 409 into its error state and own the one
  handler that adopts it while keeping the chosen member (picking new nights
  deliberately clears the member, so the existing handler cannot be reused).
  The button itself lives in the assignment form component. The custodian tick
  (owner decision on #3820) adds its state, its line in the POST body and its
  reset, and the bed-allocation flag that hides Hold a bed / Change bed while
  the module is off; the tick's markup lives in the form component too.
  The review round added the per-row Custodian toggle (a ViewOnlyActionButton
  sharing the bed save path, which is why it lives beside Release bed and
  Change bed), the tick reset on every member, night and lodge change, and the
  advisory note. The delta review added the no-bed wording of the two confirm
  cards (which card speaks of a bed depends on whether one is in play) and the
  edit's two-spaces advisory in the same slot as the create's.
