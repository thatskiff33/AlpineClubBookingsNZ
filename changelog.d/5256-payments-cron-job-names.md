- **The payments cycle's job names are now spelled in one place, and a test
  stops a stray copy (#5256).** The eight jobs of the 15-minute payments cycle
  (`once-ever-alert-sweep`, `payment-recovery`,
  `internet-banking-hold-release`, `xero-waiting-invoice-reaper`,
  `late-capture-held-alert`, `credit-release-asks`,
  `duplicate-capture-kept-alert` and `combined-invoice-cover-release`) were
  named once where they run and again where Admin → Cron Health lists them, so
  renaming one side would have left a row that never reports with no test
  failing. They now live in one module the runner, the health page and the
  scheduler all read, as the Xero jobs have since #5077, and the job-name test
  that guarded the Xero names now guards both. Nothing an operator sees
  changes: the names, the stored run history, the Cron Health rows and the
  Sentry monitor are all the same.
