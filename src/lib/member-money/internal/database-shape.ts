import type { MEMBER_MONEY_RELATIONS } from "../../member-money-tables";

type Relation = (typeof MEMBER_MONEY_RELATIONS)[number];

/** A routine as `pg_proc` holds it: its body's md5 and the settings it runs with. */
export interface MemberMoneyFunctionShape {
  /** `md5(prosrc)`. */
  source: string;
  /** `provolatile`, spelled out. */
  volatility: "immutable" | "stable" | "volatile";
  /** `prosecdef`. */
  securityDefiner: boolean;
  /** `proconfig`: the `SET` clauses, such as the `search_path` each body relies on. */
  config: readonly string[];
}

/**
 * The enforcement the journal's migration installs, as the verifier expects to
 * find it (#4513). ONE constant:
 *
 * - `functions`: the md5 of each `member_money_*` routine's body,
 *   `pg_proc.prosrc`, with its volatility, security mode and `SET` clauses;
 * - `constraints`: each constraint's `pg_get_constraintdef` text, which must
 *   also be validated (constraint triggers are pinned as triggers);
 * - `triggers`: each trigger's `pg_get_triggerdef` text (its function, timing,
 *   events, condition and deferral), which must also be enabled; a trigger not
 *   named here is reported as unexpected;
 * - `uniqueIndexes`: each unique index's `pg_get_indexdef` text, which must
 *   also be valid, ready and live.
 *
 * PostgreSQL stores a function body and its settings as written, so
 * `member-money-database-shape.test.ts` derives `functions` from the migration
 * file. Constraint, trigger and index definitions come back from the catalog
 * normalised, so that test checks only their names against the file, and
 * `member-money-journal.realdb.test.ts` checks every definition against a
 * freshly migrated PostgreSQL 16 database. The verifier reads them with a fixed
 * `search_path` and `quote_all_identifiers`, the settings the text depends on,
 * and compares the text exactly.
 */
export const MEMBER_MONEY_DATABASE_SHAPE = {
  functions: {
    member_money_system_identifier: {
      source: "84a6311f30559828a65a0fcfb6e46c4b", volatility: "stable", securityDefiner: false,
      config: ["search_path=pg_catalog"],
    },
    member_money_refuse_mutation: {
      source: "1f3a39b585e154e2de7c93967840b72c", volatility: "volatile", securityDefiner: false,
      config: ["search_path=pg_catalog, public"],
    },
    member_money_check_seal: {
      source: "9b1a9be58cc2efc7b47ef9f8e99a6cd8", volatility: "volatile", securityDefiner: false,
      config: ["search_path=pg_catalog, public"],
    },
    member_money_batch_errors: {
      source: "cbb4fab0548c90641ea97c8a9cf94c97", volatility: "stable", securityDefiner: false,
      config: ["search_path=pg_catalog, public"],
    },
    member_money_require_complete: {
      source: "876201ea45a0f01b0269c311fd85e3ff", volatility: "volatile", securityDefiner: false,
      config: ["search_path=pg_catalog, public"],
    },
  },
  constraints: {
    MemberMoneyEvent: {
      MemberMoneyEvent_pkey:
        `PRIMARY KEY (id)`,
      member_money_event_evidence:
        `CHECK (((length(btrim("eventKey")) > 0) AND (length(btrim("sourceIdentity")) > 0) AND (length(btrim("sourceVersion")) > 0) AND (length(btrim(reason)) > 0) AND ("payloadHash" ~ '^[0-9a-f]{64}$'::text)))`,
    },
    MemberMoneyJournal: {
      MemberMoneyJournal_eventId_fkey:
        `FOREIGN KEY ("eventId") REFERENCES "MemberMoneyEvent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyJournal_pkey:
        `PRIMARY KEY (id)`,
      MemberMoneyJournal_reversesJournalId_fkey:
        `FOREIGN KEY ("reversesJournalId") REFERENCES "MemberMoneyJournal"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      member_money_header_shape:
        `CHECK ((((currency)::text ~ '^[A-Z]{3}$'::text) AND ("expectedLineCount" >= 0) AND ("expectedObligationCount" >= 0) AND ("expectedApplicationCount" >= 0) AND (length(btrim("policyVersion")) > 0) AND (length(btrim("codingVersion")) > 0) AND (id IS DISTINCT FROM "reversesJournalId")))`,
    },
    MemberMoneyLine: {
      MemberMoneyLine_bookingId_fkey:
        `FOREIGN KEY ("bookingId") REFERENCES "Booking"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyLine_journalId_fkey:
        `FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyLine_lodgeId_fkey:
        `FOREIGN KEY ("lodgeId") REFERENCES "Lodge"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyLine_obligationId_fkey:
        `FOREIGN KEY ("obligationId") REFERENCES "MemberMoneyObligation"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyLine_originalLineId_fkey:
        `FOREIGN KEY ("originalLineId") REFERENCES "MemberMoneyLine"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyLine_pkey:
        `PRIMARY KEY (id)`,
      MemberMoneyLine_sourceLinkId_journalId_fkey:
        `FOREIGN KEY ("sourceLinkId", "journalId") REFERENCES "MemberMoneySourceLink"(id, "journalId") ON UPDATE RESTRICT ON DELETE RESTRICT`,
      member_money_line_debtor:
        `CHECK (\nCASE "debtorKind"\n    WHEN 'MEMBER'::"MemberMoneyDebtorKind" THEN (("memberId" IS NOT NULL) AND (length(btrim("memberId")) > 0) AND ("organisationId" IS NULL))\n    WHEN 'ORGANISATION'::"MemberMoneyDebtorKind" THEN (("organisationId" IS NOT NULL) AND (length(btrim("organisationId")) > 0) AND ("memberId" IS NULL))\n    ELSE (("memberId" IS NULL) AND ("organisationId" IS NULL))\nEND)`,
      member_money_line_shape:
        `CHECK ((("amountCents" > 0) AND ((account <> ALL (ARRAY['MEMBER_RECEIVABLE'::"MemberMoneyAccount", 'MEMBER_CREDIT'::"MemberMoneyAccount", 'REFUND_PAYABLE'::"MemberMoneyAccount"])) OR ("debtorKind" IS NOT NULL)) AND ((account <> 'MEMBER_CREDIT'::"MemberMoneyAccount") OR ("creditLotId" IS NOT NULL)) AND ((account <> 'MEMBER_CREDIT'::"MemberMoneyAccount") OR ("debtorKind" = 'MEMBER'::"MemberMoneyDebtorKind")) AND ((account <> 'REFUND_PAYABLE'::"MemberMoneyAccount") OR ("obligationId" IS NOT NULL)) AND (("bookingId" IS NULL) OR ("lodgeId" IS NOT NULL)) AND (id IS DISTINCT FROM "originalLineId")))`,
      member_money_tax_split:
        `CHECK (((("grossCents" IS NULL) AND ("netCents" IS NULL) AND ("taxCents" IS NULL) AND ("taxCode" IS NULL)) OR (("grossCents" IS NOT NULL) AND ("netCents" IS NOT NULL) AND ("taxCents" IS NOT NULL) AND ("taxCode" IS NOT NULL) AND (length(btrim("taxCode")) > 0) AND ("grossCents" >= 0) AND ("netCents" >= 0) AND ("taxCents" >= 0) AND (("grossCents")::bigint = (("netCents")::bigint + ("taxCents")::bigint)))))`,
    },
    MemberMoneyObligation: {
      MemberMoneyObligation_journalId_fkey:
        `FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyObligation_pkey:
        `PRIMARY KEY (id)`,
      member_money_obligation_debtor:
        `CHECK (\nCASE "debtorKind"\n    WHEN 'MEMBER'::"MemberMoneyDebtorKind" THEN (("memberId" IS NOT NULL) AND (length(btrim("memberId")) > 0) AND ("organisationId" IS NULL))\n    WHEN 'ORGANISATION'::"MemberMoneyDebtorKind" THEN (("organisationId" IS NOT NULL) AND (length(btrim("organisationId")) > 0) AND ("memberId" IS NULL))\n    ELSE false\nEND)`,
      member_money_obligation_shape:
        `CHECK ((("faceCents" > 0) AND (length(btrim("obligationKey")) > 0)))`,
    },
    MemberMoneyApplication: {
      MemberMoneyApplication_journalId_fkey:
        `FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyApplication_obligationId_fkey:
        `FOREIGN KEY ("obligationId") REFERENCES "MemberMoneyObligation"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyApplication_pkey:
        `PRIMARY KEY (id)`,
      MemberMoneyApplication_reversesApplicationId_fkey:
        `FOREIGN KEY ("reversesApplicationId") REFERENCES "MemberMoneyApplication"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneyApplication_sourceLineId_fkey:
        `FOREIGN KEY ("sourceLineId") REFERENCES "MemberMoneyLine"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      member_money_application_shape:
        `CHECK ((("amountCents" > 0) AND (length(btrim("applicationKey")) > 0) AND (id IS DISTINCT FROM "reversesApplicationId")))`,
    },
    MemberMoneySourceLink: {
      MemberMoneySourceLink_bookingLedgerLineId_fkey:
        `FOREIGN KEY ("bookingLedgerLineId") REFERENCES "BookingLedgerLine"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneySourceLink_journalId_fkey:
        `FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneySourceLink_pkey:
        `PRIMARY KEY (id)`,
      member_money_source_shape:
        `CHECK (((length(btrim("sourceId")) > 0) AND (length(btrim("sourceVersion")) > 0) AND ((("sourceKind" = 'BOOKING_LEDGER'::"MemberMoneySourceKind") AND ("bookingLedgerLineId" IS NOT NULL) AND ("sourceId" = "bookingLedgerLineId")) OR (("sourceKind" <> 'BOOKING_LEDGER'::"MemberMoneySourceKind") AND ("bookingLedgerLineId" IS NULL)))))`,
    },
    MemberMoneySourcePosting: {
      MemberMoneySourcePosting_lineId_journalId_fkey:
        `FOREIGN KEY ("lineId", "journalId") REFERENCES "MemberMoneyLine"(id, "journalId") ON UPDATE RESTRICT ON DELETE RESTRICT`,
      MemberMoneySourcePosting_pkey:
        `PRIMARY KEY (id)`,
      MemberMoneySourcePosting_sourceLinkId_journalId_fkey:
        `FOREIGN KEY ("sourceLinkId", "journalId") REFERENCES "MemberMoneySourceLink"(id, "journalId") ON UPDATE RESTRICT ON DELETE RESTRICT`,
    },
  },
  triggers: {
    MemberMoneyEvent: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneyEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyEvent" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneyEvent" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
    },
    MemberMoneyJournal: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneyJournal" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyJournal" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneyJournal" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_seal:
        `CREATE TRIGGER member_money_seal BEFORE INSERT ON public."MemberMoneyJournal" FOR EACH ROW EXECUTE FUNCTION member_money_check_seal()`,
    },
    MemberMoneyLine: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneyLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyLine" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneyLine" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_seal:
        `CREATE TRIGGER member_money_seal BEFORE INSERT ON public."MemberMoneyLine" FOR EACH ROW EXECUTE FUNCTION member_money_check_seal()`,
    },
    MemberMoneyObligation: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneyObligation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyObligation" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneyObligation" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_seal:
        `CREATE TRIGGER member_money_seal BEFORE INSERT ON public."MemberMoneyObligation" FOR EACH ROW EXECUTE FUNCTION member_money_check_seal()`,
    },
    MemberMoneyApplication: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneyApplication" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyApplication" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneyApplication" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_seal:
        `CREATE TRIGGER member_money_seal BEFORE INSERT ON public."MemberMoneyApplication" FOR EACH ROW EXECUTE FUNCTION member_money_check_seal()`,
    },
    MemberMoneySourceLink: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneySourceLink" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneySourceLink" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneySourceLink" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
    },
    MemberMoneySourcePosting: {
      member_money_complete:
        `CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneySourcePosting" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete()`,
      member_money_immutable:
        `CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneySourcePosting" FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation()`,
      member_money_no_truncate:
        `CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneySourcePosting" FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation()`,
    },
  },
  uniqueIndexes: {
    MemberMoneyEvent: {
      MemberMoneyEvent_eventKey_key:
        `CREATE UNIQUE INDEX "MemberMoneyEvent_eventKey_key" ON public."MemberMoneyEvent" USING btree ("eventKey")`,
      MemberMoneyEvent_pkey:
        `CREATE UNIQUE INDEX "MemberMoneyEvent_pkey" ON public."MemberMoneyEvent" USING btree (id)`,
    },
    MemberMoneyJournal: {
      MemberMoneyJournal_eventId_key:
        `CREATE UNIQUE INDEX "MemberMoneyJournal_eventId_key" ON public."MemberMoneyJournal" USING btree ("eventId")`,
      MemberMoneyJournal_pkey:
        `CREATE UNIQUE INDEX "MemberMoneyJournal_pkey" ON public."MemberMoneyJournal" USING btree (id)`,
      MemberMoneyJournal_reversesJournalId_key:
        `CREATE UNIQUE INDEX "MemberMoneyJournal_reversesJournalId_key" ON public."MemberMoneyJournal" USING btree ("reversesJournalId")`,
    },
    MemberMoneyLine: {
      MemberMoneyLine_id_journalId_key:
        `CREATE UNIQUE INDEX "MemberMoneyLine_id_journalId_key" ON public."MemberMoneyLine" USING btree (id, "journalId")`,
      MemberMoneyLine_originalLineId_key:
        `CREATE UNIQUE INDEX "MemberMoneyLine_originalLineId_key" ON public."MemberMoneyLine" USING btree ("originalLineId")`,
      MemberMoneyLine_pkey:
        `CREATE UNIQUE INDEX "MemberMoneyLine_pkey" ON public."MemberMoneyLine" USING btree (id)`,
    },
    MemberMoneyObligation: {
      MemberMoneyObligation_obligationKey_key:
        `CREATE UNIQUE INDEX "MemberMoneyObligation_obligationKey_key" ON public."MemberMoneyObligation" USING btree ("obligationKey")`,
      MemberMoneyObligation_pkey:
        `CREATE UNIQUE INDEX "MemberMoneyObligation_pkey" ON public."MemberMoneyObligation" USING btree (id)`,
    },
    MemberMoneyApplication: {
      MemberMoneyApplication_applicationKey_key:
        `CREATE UNIQUE INDEX "MemberMoneyApplication_applicationKey_key" ON public."MemberMoneyApplication" USING btree ("applicationKey")`,
      MemberMoneyApplication_pkey:
        `CREATE UNIQUE INDEX "MemberMoneyApplication_pkey" ON public."MemberMoneyApplication" USING btree (id)`,
      MemberMoneyApplication_reversesApplicationId_key:
        `CREATE UNIQUE INDEX "MemberMoneyApplication_reversesApplicationId_key" ON public."MemberMoneyApplication" USING btree ("reversesApplicationId")`,
    },
    MemberMoneySourceLink: {
      MemberMoneySourceLink_bookingLedgerLineId_key:
        `CREATE UNIQUE INDEX "MemberMoneySourceLink_bookingLedgerLineId_key" ON public."MemberMoneySourceLink" USING btree ("bookingLedgerLineId")`,
      MemberMoneySourceLink_id_journalId_key:
        `CREATE UNIQUE INDEX "MemberMoneySourceLink_id_journalId_key" ON public."MemberMoneySourceLink" USING btree (id, "journalId")`,
      MemberMoneySourceLink_pkey:
        `CREATE UNIQUE INDEX "MemberMoneySourceLink_pkey" ON public."MemberMoneySourceLink" USING btree (id)`,
      MemberMoneySourceLink_sourceKind_sourceId_sourceVersion_key:
        `CREATE UNIQUE INDEX "MemberMoneySourceLink_sourceKind_sourceId_sourceVersion_key" ON public."MemberMoneySourceLink" USING btree ("sourceKind", "sourceId", "sourceVersion")`,
    },
    MemberMoneySourcePosting: {
      MemberMoneySourcePosting_pkey:
        `CREATE UNIQUE INDEX "MemberMoneySourcePosting_pkey" ON public."MemberMoneySourcePosting" USING btree (id)`,
      MemberMoneySourcePosting_sourceLinkId_lineId_key:
        `CREATE UNIQUE INDEX "MemberMoneySourcePosting_sourceLinkId_lineId_key" ON public."MemberMoneySourcePosting" USING btree ("sourceLinkId", "lineId")`,
    },
  },
} as const satisfies {
  functions: Record<string, MemberMoneyFunctionShape>;
  constraints: Record<Relation, Record<string, string>>;
  triggers: Record<Relation, Record<string, string>>;
  uniqueIndexes: Record<Relation, Record<string, string>>;
};
