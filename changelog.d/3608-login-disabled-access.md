- **Switching off a member's login now ends their access straight away
  (#3603).** Turning off "Can log in" for a member, including handing a family
  group's login to another member, now signs that person out on their next
  request. Until now, someone who was already signed in could keep carrying out
  admin actions, and keep using the finance area and the lodge kiosk, until
  their session ran out. Admin pages themselves were already closed to them.

  Every check that decides what a signed-in person may do now takes the login
  switch into account: admin actions, the finance area, the lodge kiosk and its
  preview, member pages, and help-assistant answers. The time of the switch-off
  is recorded against the member, so signing out is final: if login is switched
  back on, the member signs in again as normal, and any session from before the
  switch-off stays ended.

  Hut-leader PINs are not affected. A PIN belongs to a hut-leader assignment
  and keeps working while the member is active, because hut leaders can be
  members who have never had a login.

  This release includes a small database migration. It adds the switch-off
  time and records it for every member whose login is already off, so their
  earlier sessions are covered too. Nothing else changes about who holds which
  role: a member whose login is off keeps their stored roles, so the existing
  protections still apply, and such an account still cannot be merged away or
  deleted while it holds Full Admin.
