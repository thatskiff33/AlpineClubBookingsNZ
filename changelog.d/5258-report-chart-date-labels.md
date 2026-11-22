- **The report charts write their dates in the club's date format (#5258).**
  The date labels along the bottom of the Reports page charts, and the dates in
  their tooltips, used to be written the American way ("Apr 16") whatever the
  club had chosen on the Club Currency & Locale page. They now follow that
  setting, like every other date on the page. On `en-NZ` a daily label reads
  "16 Apr", the same way as the dates in the tables beside it, and the revenue
  chart's labels follow the setting too ("Thu, 16 Apr" rather than
  "Thu 16 Apr"). The CSV's revenue period column holds the same text as the
  revenue chart's tooltips, so it follows the setting as well: on `en-NZ` a
  daily row now reads "Thursday, 16 April 2026" rather than
  "Thursday 16 April 2026", and a weekly row writes September as "Sept"
  ("Week of 31 Aug 2026 to 6 Sept 2026"). No figure changes.
