# #3794 CI fix source check

Root read exact e66667fab..96e291eae production/guard delta and relevant INV-MOD-028/036 definitions. No implementation authored by root in this fix.

The planner's required nullable price field prevents either caller omitting the new evidence at compile time. Naming and approval both select it and run the shared proof before their claims. NULL refusal is defined once in that shared planner. Naming's SQL not-null filter protects the later write independently against invalidated evidence, and the existing exact-count throw rejects the transaction; it does not reconstruct a number for a blank.

New census exception is restricted to its one named writer, exactly one direct write, immutable proved IDs, explicit non-null predicate and affected-count throw. It uses the existing canonical stripCommentsAndStrings. Four mutations prove loss of each fence or introduction of a second writer is rejected. This extends the existing scanner rather than creating a parallel scanner. Actual production mutation evidence includes all three PostgreSQL failures and guard failure, with byte-identical restoration; final167 focused tests34PG passed as recorded by implementor.

New guard module changes are receiving an independent focused contracts review; original three critical lenses are not being repeated across the full repair. Root's check is source-only and does not add runtime evidence.

