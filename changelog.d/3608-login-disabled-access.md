- **Switching off a member's login now ends their access straight away
  (#3603).** Turning off "Can log in" for a member, including handing a family
  group's login to another member, now signs that person out on their next
  request. Until now, someone who was already signed in could keep using admin,
  finance and lodge screens until their session ran out.

  Every check that decides what a signed-in person may do now takes the login
  switch into account: admin pages and their actions, the finance area, the
  lodge kiosk and its preview, and help-assistant answers. Signing out is
  final. If login is switched back on, the member signs in again as normal.

  Nothing else changes about who holds which role. A member whose login is off
  keeps their stored roles, so the existing protections still apply: such an
  account still cannot be merged away or deleted while it holds Full Admin.
