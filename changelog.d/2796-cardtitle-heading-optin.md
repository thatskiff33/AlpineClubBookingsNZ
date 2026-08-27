- Card titles can now carry real heading semantics. `CardTitle` gained an opt-in
  `headingLevel` prop, so a card that is a page's section says so and appears in a screen
  reader's heading list — one of the two main ways an assistive-technology user navigates a
  page. Nothing changes for a card that does not opt in, and nothing changes visually
  anywhere. The pay-door cards a locked-out member is sent to, the roster editor, and the
  bed-allocation panel now use it instead of hand-written ARIA, and a guard keeps there
  being one spelling of the mechanism rather than two.
