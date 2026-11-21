- **Members can connect an AI app such as Claude or ChatGPT to their own
  account (ALP-653).** A new module, **AI app connections (MCP)**, is off until
  a club turns it on. A member adds the address shown under **Connected AI
  apps** on their profile to their AI app, signs in on the club website and
  approves the app. The app can then check availability, read their bookings,
  profile and notices, start a draft booking and cancel a booking, acting with
  that member's permissions only. Card payments, password and sign-in changes,
  and anything an officer must confirm again stay on the website.

  Club officers choose who may connect (members are allowed, officers are not
  until switched on), whether connections may make changes (view only to start
  with) and which AI apps are approved, at **Admin → Help & system → AI app
  connections**, where they can also disconnect any member's app. Whatever a
  member asks about is sent to their AI app's provider, so cover this in the
  club's privacy notice before turning it on. The recipient register gains an
  `ai-apps` row, and an unedited starter privacy policy gains an **AI apps you
  connect** entry in section 5 (#5305). The AI app connections guide
  (`docs/guides/mcp-server.md`) explains the settings, what each action sends
  and the risks.

  Removing an app from the approved list stops its existing connections on
  their next use. An officer's connection acts as a member in this release: it
  cannot cancel or preview anyone else's booking.

  Connection events and change actions use a new `security` audit writer,
  visible to officers with support view permission. No existing audit rows
  are reclassified; action arguments and results are never recorded.

  The connection list includes page controls and totals so older apps remain
  reachable, and identifies each app by its approved destination. Concurrent
  approvals replace the earlier connection safely; settings audits record the
  values actually replaced. OAuth requests are size-limited before parsing.
