- **Release preparation now clears spent file-size allowances (#3427).** When a
  release is compiled, the release checklist also retires allowance fragments
  that have already merged and can no longer affect the file-size budget gate.
  Local drafts and edits are preserved; the gate's limits on new files and
  first-time budget crossings are unchanged.
