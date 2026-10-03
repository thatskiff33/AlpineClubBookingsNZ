# Issue 3413 pending adult rate correction

Commit: 2b0012ba47e31996d52aa6ae2ca16fe5c9de0236 in worktree3413.

Root authorized correction within existing approved scope after composition exposed a missing quote rate: pricingCombos enumerated only named guests. A SCHOOL request with its sole teacher linked as a member and one pending adult had no ADULT non-member field; service correctly refused missing rate.

Added one local dedup helper shared by named guest combos and structural pending ADULT/nonmember combo for SCHOOL pendingAdultCount >0. No fake identities, server/provider or new product rule. Persisted count is correct authority: pending draft lives in correction editor which saves separately; quote panel only stages child counts. Other-lodge suggested-rate policy unchanged.

Regression demonstrated old code failed SCHOOL/1 missing label; SCHOOL/0 and PUBLIC/1 controls passed. All three now pass, and positive payload asserts 4700 nonmember override alongside 3500 member teacher and1000 youth. Focused 117tests across panel quote counts, booking-request-quotes, view-only-banner-contract passed. Changed-file ESLint0errors; budget against origin/main passed (2727 panel); diffcheck passed.

Merged into3414 at9ada2fe44eb3e97accb7882de4aefd429c1b97e6; combined panel2726. Forty-one focused composed UI/MoneyInput/census tests and budget passed. Full combined post-fix typecheck and changed-file ESLint passed in3414; covers helper and regression compile with MoneyInput. CI owns full suite/build and independent #3413 head. No install, push, GitHub or production access by implementor.
