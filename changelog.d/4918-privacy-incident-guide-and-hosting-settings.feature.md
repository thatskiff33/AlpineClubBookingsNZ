- **A guide for what to do after a privacy breach, a list of where members'
  data is sent, and a new "Where members' data is held" setting (#4918).**
  If members' personal information leaks — a readable backup, a compromised
  officer account, an exposed server — New Zealand's Privacy Act expects the
  club to act quickly and, when serious harm is likely, to tell the Privacy
  Commissioner and the people affected. The new privacy-incident guide walks a
  committee through the first hour: contain the leak, keep the evidence, judge
  the harm, decide whether to notify, notify, and record what happened. It
  names every key and password to replace and links to the steps for each.

  A new register lists every outside company that can receive members'
  information (payments, accounting, email, hosting, backups, Google, AI help,
  error reporting, address lookup, video meetings and the Alpine Central
  Server), what each receives and what turns it on or off.

  Under **Site Appearance & Content → Club Identity** there is a new section,
  **Where members' data is held**, for the company that hosts your system and
  the country or region your data is kept in. A new `{{data-hosting}}` page
  token shows these in a sentence on a page such as your privacy policy, with
  wording that sends members to your Privacy Officer for anything left blank.
  Each save is recorded in the Audit Log under the `admin` category, like
  Club Identity changes, so anyone with support access can see it. The row
  holds only the two hosting values, before and after, never member data.

  **This change does not alter your published privacy policy.** (The separate
  starter-policy correction, #4914, has its own note.) A later release will
  update privacy policies that still hold the unedited starter text to use
  this setting, so fill it in now.
