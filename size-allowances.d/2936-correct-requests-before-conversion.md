# File-size allowances for #2936

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2306
reason: fifty lines, and the editor itself is not among them — it is
  `booking-request-correction-editor.tsx`, a new 677-line file of its own, which
  is where the split this panel could offer has already been taken. What is left
  here is the wiring only: the import, the row's `version` field so the form can
  send back the row it was showing, and the mount inside the panel's existing
  edit-capable block. That placement is the load-bearing part and cannot move: it
  is what keeps the correction behind the same `canEdit` gate as pricing and
  approving, so a view-only admin never sees it and the panel's one view-only
  banner already explains why. Eight of the nineteen are the two comments saying
  that, and saying why the form is additionally withheld from a member
  whole-lodge request and from a row whose stored party cannot be read back —
  the two populations the service refuses anyway, which is the only record that
  the hidden control and the server refusal are the same rule stated twice on
  purpose rather than a screen deciding policy. The review round added
  thirty-one more, and they are two things this panel is the only possible home
  for. The larger is dropping this card's own UNSAVED copy of the member links
  when a correction lands: that copy is local state which wins over the
  server's and survives a refetch, so without it the next "Save quote" posts
  links keyed to a guest list that no longer exists, and puts a real member on
  somebody else's row at member rates. The state, the reader that prefers it and
  the advisory-conflict ref all live here, so the reset does too. The rest is
  the school row's copy, which told officers to decline and ask the school to
  resubmit for exactly the change the control above it now makes — and which now
  says which of the two child-count controls on this card changes the request
  and which changes only the booking about to be quoted.

file: src/lib/booking-request.ts
lines: 2928
reason: seven lines, and five of them are the comment. The code is one field:
  `serializeBookingRequestForAdmin` now returns the row's `version`, so the
  officer's correction form can send back the version it was showing and the
  service can refuse a correction written over a request an accept or a decline
  has moved underneath it. A serializer's field belongs in the serializer; the
  only seam available would put one property of one DTO in another file, where
  the next person adding a field would not find it. The comment is what stops
  the next reader treating a client-supplied counter as authority — the server
  never trusts it as anything but a fence, and that sentence is the only place
  in the tree that says so. The seventh line arrived with stage 3 (#3368),
  which had its own entry for this file until this branch merged the epic:
  the `bookingOwner` import this module needs to ask who owns a booking
  through the one accessor instead of reading the column. One file takes one
  allowance, so the two entries are folded here rather than left for a gate
  that cannot choose between two numbers.

file: src/lib/booking-request-quotes.ts
lines: 1875
reason: a hundred and ten lines across the four quote writers, and they are not a
  feature — they are this issue's own counterpart reconciliation, which the
  concurrency checklist requires and which cannot be done anywhere but at each
  writer. The correction sets a LIVE status (VERIFIED) where decline sets a
  terminal one, so all three writers' "not declined, not cancelled" guards saw
  nothing: the quote save restored a retired price and stale positional member
  links over a corrected row, the quote send flipped a SUPERSEDED quote back to
  a live SENT one with a fresh response token, and the accept re-arm wrote the
  retired price and converted — queueing the corrected school's Xero invoice.
  The fences are small (a version claim, a status claim, one lock plus a
  re-read); most of the sixty-nine lines are the comments saying which writer
  each fences against and why, because the wrong answer to that question is
  precisely what let these three go unreconciled. Splitting this file is a real
  option and a real piece of work — it is one module holding create, send, the
  requester's four responses and the hold — but doing it inside a fix round on
  three concurrency fences would put the fences in a diff nobody could review
  against the writers they guard.
  The second fix round added forty-one, and about thirty-five of them are
  comment. A review lens found that "the three quote writers" was an
  enumeration that had missed one: the requester's MODIFY/QUERY branch matches
  the same criterion and was neither fenced nor named, while a new comment
  beside the accept claimed every other branch already took the lock. The code
  change there is four lines — the quote supersede becomes a DRAFT/SENT claim,
  which is what every other supersede writer in the tree already does, so a
  retired quote cannot be re-stamped with the requester's timestamp. The rest
  is the paragraph saying the status flip is DELIBERATELY left unfenced and
  why (it writes a status and the requester's own words; fencing it would
  discard a message from the person whose booking it is), the correction to
  the accept's overclaim, and one clause on the send saying the rollback does
  not cover the hold, which committed before the transaction opened. Every one
  of those sentences belongs at the writer it describes: a reader deciding
  whether to copy the guard beside them is the exact reader who has to be told
  which of the four is not one.
