# File-size allowances for #2936

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2275
reason: nineteen lines, and the editor itself is not among them — it is
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
  purpose rather than a screen deciding policy.

file: src/lib/booking-request.ts
lines: 2927
reason: six lines, and five of them are the comment. The code is one field:
  `serializeBookingRequestForAdmin` now returns the row's `version`, so the
  officer's correction form can send back the version it was showing and the
  service can refuse a correction written over a request an accept or a decline
  has moved underneath it. A serializer's field belongs in the serializer; the
  only seam available would put one property of one DTO in another file, where
  the next person adding a field would not find it. The comment is what stops
  the next reader treating a client-supplied counter as authority — the server
  never trusts it as anything but a fence, and that sentence is the only place
  in the tree that says so.
