- **The starter privacy policy now lists every outside service that can
  receive members' information, and names your host from your own settings
  (#5007).** Section 5 used to list only Stripe, Xero, Amazon SES, a general
  hosting and backup line and Google Analytics, and a note in the policy asked
  the club to name its host and region by hand. It now lists payments,
  accounting, email, hosting, backups, Google, AI help, error reporting,
  breached-password checks, address lookup, video meetings and the Alpine
  Central Server, links to the privacy notice the register records for each,
  and marks the optional ones "Only if the club turns it on". The host and
  the place your data is held come from **Where members' data is held** under
  Club Identity; until that is filled in, the page tells members to ask your
  Privacy Officer. Backups move into section 5's list, and section 6 refers to
  the host described there.

  A privacy page that still holds the unedited starter text is updated once on
  upgrade. A page your club edited is not changed: check its sections 5 and 6
  yourself. Importing a configuration bundle exported before this release no
  longer brings the replaced starter text back. Be on v0.14.0 or later before
  you upgrade to this release: v0.14.0 added the hosting setting and the token
  the new text uses, and a club that skips it shows the token as raw text.
