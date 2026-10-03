# #3679 focused browser verification

Exact verified source: `7ce3bb1eaa65e45e32185cefc7af93400ab2d763` in `[dedicated worktree]`.

## Result

Twelve unique focused desktop/mobile scenarios passed using the installed Chromium and Playwright. No MoneyInput adoption defect was confirmed in these scenarios. The existing saved-season action row has mobile overflow; its cause was established independently of MoneyInput and remains outside this issue's scope.

## Harness and authorization

Private ignored harness: `.artifacts/ui-verify-3679`, outside the compose worktree. It imports the actual `FeesPageClient` (therefore both actual fee sections), `PublicBookingRequestsPanel`, `RefundAppealButton`, `MoneyInput`, Radix controls and ClubFormat/ClubTime/ClubIdentity providers. It compiles the production `src/app/globals.css` with installed Tailwind/PostCSS. The actual SessionProvider receives a synthetic session. Only HTTP data and Next navigation are mocked; unexpected or external requests are refused. No provider or database was contacted.

The build checks the exact SHA and refuses tracked changes. No install or implicit download was used. Root started `htt[historical local path omitted]` and retained server session `49451`; this agent used that loopback only after explicit runtime authorization. Root owns shutdown. No further browser checks remain.

## Coverage

Both 1280×900 desktop and 390×844 Chromium touch/mobile emulation covered:

| Actual surface | Verified behavior |
| --- | --- |
| Hut fee season editor | Whole-dollar ArrowUp/Down; button keyboard focus and activation on desktop; taps on mobile; preserved fractional cents; precision restriction; malformed/empty/boundary handling; no unintended POST/PUT when using buttons or keys inside the actual season form |
| Joining and annual fee grids | Actual five-column joining grid and annual component editor; dollar controls; disabled single-component mirror; two editable component rows; no submission during stepping; money groups remain within their fields |
| School quote editor | Both catered/non-catered totals and ten actual guest-night rate controls; native Radix pricing-mode switch; keyboard/touch steps; no quote write during stepping; no horizontal page overflow at either tested viewport |
| Public refund appeal | Actual rendered member-facing form; keyboard/touch controls; no appeal during stepping; explicit submit emits one synthetic request containing exactly 4567 cents for 45.67 |
| Consumer permission/data gates | View-only fee editors absent; actual view-only quote editor absent; actual quote inputs/buttons disabled for unreadable quote data |
| Supplementary actual MoneyInput boundary | Genuine signed crossing -1.50 → -0.50 → 0.50 → -0.50; disabled and read-only controls; buttons/keyboard do not submit the enclosing fixture form; explicit Submit proves the form remains usable |

The geometry collection found no money-control overflow beyond its field, ancestor clipping, or obstructed visible control centers. Step buttons measured at least 24×24 CSS pixels. Focused inspection found a visible native keyboard outline (`auto`, 1px) on the Increase button. Touch taps changed the correct amounts.

## Existing mobile fee-page overflow

The untouched actual FeesPageClient initially renders **zero** MoneyInputs. At a configured 390px mobile viewport, its saved-season header is 258px wide (left 66/right 324), while the existing `flex space-x-2` action group is 356.83px wide (left 270.52/right 627.34). The document extends to 627px. Removing **only** that saved-season action group restores document width to 390px, still with zero MoneyInputs. This is a diagnostic DOM removal, not a product edit.

`git diff origin/main..7ce3bb1e -- src/app/(admin)/admin/fees/_components/hut-fees-section.tsx` contains only the MoneyInput imports and three substitutions; the saved-season header/action markup is unchanged. Together with the zero-control browser measurement and removal comparison, this refutes the overflow as an adoption regression. The money groups stayed contained and their tap targets received input, but the overall fee page cannot be called overflow-free on mobile. Browser scaling/physical-device usability on that existing page is not claimed. Root requested that the unrelated header remain outside the MoneyInput scope.

## Evidence

Raw reports under `.artifacts/ui-verify-3679/evidence/`:

- `report.json`: eight passing scenarios, plus four harness-assumption failures.
- `quote-followup.json`: all four affected scenarios pass after correcting those assumptions. The link-conflicts endpoint is a read-only POST advisory, and the real view-only quote panel hides its editor. These were harness errors, not application defects. The other eight scenarios were not repeated.
- `focused-inspection.json`: exact header/action bounds, zero-control counterexample, restored width after removing only the action group, and keyboard focus style.

Screenshots inspected by this agent include:

- `desktop-joining-fees-focus.png`: dense five-column field layout and keyboard outline.
- `desktop-fees-finance.png`: actual annual/component editor.
- `mobile-fees-finance.png` and `mobile-joining-fees-focus.png`: actual mobile fee editors.
- `mobile-quotes-rates.png`: both options and ten contained rate controls.
- `mobile-refund-keyboard-focus.png`: public appeal controls and visible keyboard focus.
- `mobile-fees-initial-header.png` / `mobile-fees-initial-without-season-actions.png`: overflow cause comparison.

Root additionally inspected `mobile-fees-hut.png` and the mobile refund screenshots.

## Limits

This is an isolated actual-component browser check with synthetic data, not a full application route journey. It does not assert route authentication, database/provider behavior, the complete admin shell/sidebar, deployed custom theme/font settings, an OS decimal keyboard or a physical touch device. The standalone boundary fixture supplements the actual consumer scenarios and is not presented as a substitute consumer form. Existing CI browser suites are separate evidence. No live service, tracked edit, GitHub write, install, full suite or application server was started by this agent.

## Reproduction commands

From the compose worktree, using its installed dependencies:

```powershell
node [historical local path omitted] [historical local path omitted]
# Root alone starts/stops this process:
node [historical local path omitted] 4179
node [historical local path omitted] [historical local path omitted] htt[historical local path omitted]
```

The amended check script now contains the corrected assumptions, so a fresh full invocation would cover all twelve scenarios. That fresh invocation was not performed because the eight already-passing scenarios had no remaining risk requiring repetition.

