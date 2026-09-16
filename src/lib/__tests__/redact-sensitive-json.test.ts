import { describe, expect, it } from "vitest";
import {
  formatRedactedJson,
  redactSensitiveJson,
  redactSensitiveQueryParams,
  redactSensitiveRecord,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json";

describe("redact-sensitive-json", () => {
  it("redacts sensitive header and token fields in nested payloads", () => {
    expect(
      redactSensitiveJson({
        response: {
          headers: {
            authorization: "Bearer live-token",
            "set-cookie": "session=abc123",
          },
        },
        request: {
          accessToken: "access-token",
          refresh_token: "refresh-token",
          password: "hunter2",
        },
      })
    ).toEqual({
      response: {
        headers: {
          authorization: "[REDACTED]",
          "set-cookie": "[REDACTED]",
        },
      },
      request: {
        accessToken: "[REDACTED]",
        refresh_token: "[REDACTED]",
        password: "[REDACTED]",
      },
    });
  });

  it("redacts JSON-shaped error text that includes an authorization header", () => {
    expect(
      redactSensitiveText(
        '400: {"response":{"statusCode":400,"request":{"headers":{"authorization":"Bearer live-token"}}}}'
      )
    ).toBe(
      '400: {"response":{"statusCode":400,"request":{"headers":{"authorization":"[REDACTED]"}}}}'
    );
  });

  it("redacts stripe token fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        payment: {
          stripeToken: "st_123",
          stripe_token: "st_456",
        },
      })
    ).toEqual({
      payment: {
        stripeToken: "[REDACTED]",
        stripe_token: "[REDACTED]",
      },
    });
  });

  it("preserves identifiers that merely contain a run of digits", () => {
    // cuids embed digit runs; e.g. "cmqdxeu50002101n22w2ivcas" contains
    // "50002101". These must not be treated as phone numbers, because they are
    // load-bearing in persisted payloads (e.g. a requeue's originalOperationId).
    expect(
      redactSensitiveJson({
        originalOperationId: "cmqdxeu50002101n22w2ivcas",
        bookingId: "cmp20vk3t00q12345678npunsc",
      })
    ).toEqual({
      originalOperationId: "cmqdxeu50002101n22w2ivcas",
      bookingId: "cmp20vk3t00q12345678npunsc",
    });
    expect(redactSensitiveText("cmqdxeu50002101n22w2ivcas")).toBe(
      "cmqdxeu50002101n22w2ivcas"
    );
  });

  it("still redacts standalone phone-like numbers on generic fields", () => {
    expect(redactSensitiveJson({ note: "call 021234567 today" })).toEqual({
      note: "[REDACTED]",
    });
    expect(redactSensitiveJson({ ref: "+64211234567" })).toEqual({
      ref: "[REDACTED]",
    });
  });

  it("redacts email and phone fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        email: "a@b.com",
        phone: "+64211234567",
      })
    ).toEqual({
      email: "[REDACTED]",
      phone: "[REDACTED]",
    });
  });

  it("redacts email values on generic fields", () => {
    expect(
      redactSensitiveJson({
        to: "a@b.com",
      })
    ).toEqual({
      to: "[REDACTED]",
    });
  });

  it("redacts Stripe payment method fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        payment_method: "pm_1ABC",
      })
    ).toEqual({
      payment_method: "[REDACTED]",
    });
  });

  it("redacts stripe token fields in JSON-shaped text", () => {
    expect(
      redactSensitiveText(
        '500: {"payment":{"stripeToken":"st_123","stripe_token":"st_456"}}'
      )
    ).toBe(
      '500: {"payment":{"stripeToken":"[REDACTED]","stripe_token":"[REDACTED]"}}'
    );
  });

  it("redacts newly sensitive keys in JSON-shaped text", () => {
    expect(
      redactSensitiveText(
        '500: {"email":"a@b.com","phone":"+64211234567","payment_method":"pm_1ABC","chargeId":"ch_1ABC"}'
      )
    ).toBe(
      '500: {"email":"[REDACTED]","phone":"[REDACTED]","payment_method":"[REDACTED]","chargeId":"[REDACTED]"}'
    );
  });

  it("formats redacted JSON for display", () => {
    expect(
      formatRedactedJson({
        headers: {
          authorization: "Bearer live-token",
        },
      })
    ).toContain('"authorization": "[REDACTED]"');
  });

  it("redacts token-bearing URL path segments", () => {
    expect(
      redactSensitiveText(
        "GET /membership-cancellation/abcDEF123_token-with-mixed 200 OK"
      )
    ).toBe("GET /membership-cancellation/[REDACTED] 200 OK");

    expect(
      redactSensitiveText(
        "https://example.test/membership-cancellation/x9_y7-zZ on visit"
      )
    ).toBe("https://example.test/membership-cancellation/[REDACTED] on visit");

    // Subsequent path segments stay intact.
    expect(
      redactSensitiveText(
        "/membership-cancellation/aA1_-/extra/path?keep=true"
      )
    ).toBe("/membership-cancellation/[REDACTED]/extra/path?keep=true");

    expect(
      redactSensitiveText(
        "GET /chores/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /chores/[REDACTED]");

    expect(
      redactSensitiveText(
        "GET /nominations/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /nominations/[REDACTED]");

    expect(
      redactSensitiveText(
        "GET /pay/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /pay/[REDACTED]");

    expect(
      redactSensitiveText(
        "POST /api/pay/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/payment-intent"
      )
    ).toBe("POST /api/pay/[REDACTED]/payment-intent");

    expect(
      redactSensitiveText(
        "GET /booking-requests/verify/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /booking-requests/verify/[REDACTED]");

    expect(
      redactSensitiveText(
        "GET /api/group-bookings/join/verify/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 200 OK"
      )
    ).toBe("GET /api/group-bookings/join/verify/[REDACTED] 200 OK");

    // Subsequent path segments stay intact for the group-join token path too.
    expect(
      redactSensitiveText("/group-bookings/join/verify/aA1_-/extra?keep=true")
    ).toBe("/group-bookings/join/verify/[REDACTED]/extra?keep=true");
  });

  it("redacts token-bearing callback URLs after URL encoding", () => {
    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fmembership-cancellation%2FabcDEF123_token 302"
      )
    ).toBe("GET /login?callbackUrl=%2Fmembership-cancellation%2F[REDACTED] 302");

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fnominations%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe("GET /login?callbackUrl=%2Fnominations%2F[REDACTED] 302");

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fpay%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe("GET /login?callbackUrl=%2Fpay%2F[REDACTED] 302");

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fbooking-requests%2Fverify%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe(
      "GET /login?callbackUrl=%2Fbooking-requests%2Fverify%2F[REDACTED] 302"
    );

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fgroup-bookings%2Fjoin%2Fverify%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe(
      "GET /login?callbackUrl=%2Fgroup-bookings%2Fjoin%2Fverify%2F[REDACTED] 302"
    );
  });

  it("redacts token query parameters and Stripe client secrets in plain text", () => {
    expect(
      redactSensitiveText(
        "GET /reset-password?token=live-reset-token&next=/profile"
      )
    ).toBe("GET /reset-password?token=[REDACTED]&next=/profile");

    expect(
      redactSensitiveText(
        "Stripe returned client_secret=pi_123_secret_liveSecret and whsec_liveWebhookSecret"
      )
    ).toBe(
      "Stripe returned client_secret=[REDACTED] and [REDACTED]"
    );
  });

  it("redacts OAuth callback code and state query parameters in plain text", () => {
    expect(
      redactSensitiveText(
        "GET /api/admin/xero/callback?code=live-code&state=csrf-state 302"
      )
    ).toBe(
      "GET /api/admin/xero/callback?code=[REDACTED]&state=[REDACTED] 302"
    );

    expect(
      redactSensitiveText(
        "https://example.org/api/finance/xero/callback?state=csrf&code=oauth-code"
      )
    ).toBe(
      "https://example.org/api/finance/xero/callback?state=[REDACTED]&code=[REDACTED]"
    );
  });

  // #2683 problem 1: the walk had no depth limit and no circular guard, so a
  // Prisma result with a self-referencing relation overflowed the stack from
  // inside a logging call. Both tests below throw
  // "Maximum call stack size exceeded" against the pre-fix redactor.
  describe("recursion guards", () => {
    function selfReferencingPrismaResult() {
      const member: Record<string, unknown> = {
        id: "cmqdxeu50002101n22w2ivcas",
        firstName: "Jane",
      };
      const familyGroup: Record<string, unknown> = {
        id: "cmp20vk3t00q12345678npunsc",
        memberships: [member],
      };
      member.familyGroup = familyGroup;
      return member;
    }

    it("completes on a circular object and marks the back-reference", () => {
      expect(redactSensitiveJson(selfReferencingPrismaResult())).toEqual({
        id: "cmqdxeu50002101n22w2ivcas",
        firstName: "[REDACTED]",
        familyGroup: {
          id: "cmp20vk3t00q12345678npunsc",
          // Visible, not dropped: the reader is told the branch looped back.
          memberships: ["[Circular]"],
        },
      });
    });

    it("formats a circular object without throwing", () => {
      expect(
        formatRedactedJson(selfReferencingPrismaResult())
      ).toContain('"memberships": [');
      expect(formatRedactedJson(selfReferencingPrismaResult())).toContain(
        "[Circular]"
      );
    });

    it("truncates below the depth cap and says so in the output", () => {
      expect(
        redactSensitiveJson({
          l0: { l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } } },
        })
      ).toEqual({
        l0: { l1: { l2: { l3: { l4: { l5: "[TRUNCATED]" } } } } },
      });
    });

    it("keeps a scalar sitting at the cap, truncating only structure", () => {
      // The value is at the same depth as the truncated object above, but a
      // leaf carries the error context a log exists to capture, so only the
      // structure wrapped around one is cut.
      expect(
        redactSensitiveJson({
          l0: { l1: { l2: { l3: { l4: { l5: "still here" } } } } },
        })
      ).toEqual({
        l0: { l1: { l2: { l3: { l4: { l5: "still here" } } } } },
      });
    });

    it("renders a shared object twice rather than calling it circular", () => {
      // Two siblings pointing at one lodge is not a cycle. The guard tracks the
      // ancestor path, so neither copy is blanked — a repeat-visit guard would
      // have replaced the second with "[Circular]" and hidden real context.
      const lodge = { id: "cmp20vk3t00q12345678npunsc", beds: 12 };

      expect(
        redactSensitiveJson({ arrival: { lodge }, departure: { lodge } })
      ).toEqual({
        arrival: { lodge: { id: "cmp20vk3t00q12345678npunsc", beds: 12 } },
        departure: { lodge: { id: "cmp20vk3t00q12345678npunsc", beds: 12 } },
      });
    });

    it("bounds a circular object nested inside a JSON-shaped string", () => {
      // redactSensitiveText and redactSensitiveJson call each other, so the
      // depth has to survive the hop through JSON.parse.
      const payload: Record<string, unknown> = { depth: 1 };
      payload.self = payload;

      expect(() =>
        redactSensitiveJson({ note: '500: {"a":{"b":{"c":1}}}', payload })
      ).not.toThrow();
    });
  });

  // #2683 problem 2 (INV-PRIV-011).
  describe("person fields", () => {
    it("redacts name, address, date of birth, gender and occupation", () => {
      expect(
        redactSensitiveJson({
          memberId: "cmqdxeu50002101n22w2ivcas",
          firstName: "Jane",
          lastName: "Doe",
          streetAddressLine1: "12 Example Street",
          streetCity: "Tokoroa",
          streetPostalCode: "3420",
          postalAddressLine1: "PO Box 5",
          dateOfBirth: "1990-04-01",
          dob: "1990-04-01",
          gender: "FEMALE",
          occupation: "Alpine guide",
        })
      ).toEqual({
        memberId: "cmqdxeu50002101n22w2ivcas",
        firstName: "[REDACTED]",
        lastName: "[REDACTED]",
        streetAddressLine1: "[REDACTED]",
        streetCity: "[REDACTED]",
        streetPostalCode: "[REDACTED]",
        postalAddressLine1: "[REDACTED]",
        dateOfBirth: "[REDACTED]",
        dob: "[REDACTED]",
        gender: "[REDACTED]",
        occupation: "[REDACTED]",
      });
    });

    // #2859 (INV-PRIV-011). Xero's `CompanyNumber` is the NZBN field, and this
    // club uses it to carry a member's date of birth. Before #2859 the app only
    // READ it, so it never reached a stored payload; the outbound contact
    // writers now SEND it, which would otherwise have written a date of birth
    // into `XeroSyncOperation.requestPayload` and left it there for good. No
    // fragment reaches this spelling and `dd/mm/yyyy` has no value-shaped net,
    // so the key is the only line of defence.
    it("redacts the Xero company number, which carries a date of birth", () => {
      expect(
        redactSensitiveRecord({
          contacts: [
            {
              contactID: "contact_1",
              companyNumber: "15/06/1985",
            },
          ],
        })
      ).toEqual({
        contacts: [
          {
            contactID: "contact_1",
            companyNumber: "[REDACTED]",
          },
        ],
      });
      // Xero's own casing folds to the same key.
      expect(redactSensitiveJson({ CompanyNumber: "15/06/1985" })).toEqual({
        CompanyNumber: "[REDACTED]",
      });
    });

    it("catches person fields under a prefix and in Xero's own casing", () => {
      expect(
        redactSensitiveJson({
          memberFirstName: "Jane",
          actor_last_name: "Doe",
          Contact: {
            FirstName: "Jane",
            LastName: "Doe",
            Addresses: [
              { AddressType: "STREET", AddressLine1: "12 Example Street" },
            ],
          },
        })
      ).toEqual({
        memberFirstName: "[REDACTED]",
        actor_last_name: "[REDACTED]",
        Contact: {
          FirstName: "[REDACTED]",
          LastName: "[REDACTED]",
          Addresses: [
            { AddressType: "STREET", AddressLine1: "[REDACTED]" },
          ],
        },
      });
    });

    it("redacts person fields in JSON-shaped text that does not parse", () => {
      expect(
        redactSensitiveText(
          'failed on {"firstName":"Jane","lastName":"Doe","streetAddressLine1":"12 Example Street","dateOfBirth":"1990-04-01"'
        )
      ).toBe(
        'failed on {"firstName":"[REDACTED]","lastName":"[REDACTED]","streetAddressLine1":"[REDACTED]","dateOfBirth":"[REDACTED]"'
      );
    });

    it("leaves `name` alone — it is lodges, rooms and templates, not people", () => {
      // Deliberate, and load-bearing: xero-operation-summaries.ts reads group
      // names straight out of an already-redacted payload. Person names are
      // caught by the firstName/lastName fragments instead, and a call site
      // that wants to record a person logs the id. See INV-PRIV-011.
      expect(
        redactSensitiveJson({
          lodge: { id: "cmp20vk3t00q12345678npunsc", name: "Alpine Lodge" },
          room: { name: "Bunk Room" },
          defaultGroup: { name: "Members - Adult" },
        })
      ).toEqual({
        lodge: { id: "cmp20vk3t00q12345678npunsc", name: "Alpine Lodge" },
        room: { name: "Bunk Room" },
        defaultGroup: { name: "Members - Adult" },
      });
    });

    it("does not let the new person keys mangle identifiers", () => {
      // The 8+ digit carve-out and the cuid-safety rule still hold with the
      // person keys added; a key that merely CONTAINS an id stays intact.
      expect(
        redactSensitiveJson({
          originalOperationId: "cmqdxeu50002101n22w2ivcas",
          firstNameSourceId: "cmp20vk3t00q12345678npunsc",
        })
      ).toEqual({
        originalOperationId: "cmqdxeu50002101n22w2ivcas",
        // The key contains "firstname", so it is redacted by the denylist —
        // the point of this assertion is that the OTHER id is untouched.
        firstNameSourceId: "[REDACTED]",
      });
    });
  });

  it("redacts OAuth callback code and state in structured query params", () => {
    expect(
      redactSensitiveQueryParams({
        code: "oauth-code",
        state: "csrf-state",
        next: "/admin/xero",
      })
    ).toEqual({
      code: "[REDACTED]",
      state: "[REDACTED]",
      next: "/admin/xero",
    });
  });

  // #2683 review finding 1. redactSensitiveQueryParams checked ONLY the
  // OAuth/token key set, so a query parameter skipped the person and credential
  // denylist entirely. It is reachable: the admin audit-log page puts
  // memberName and memberEmail into the address bar and router.replace()s it,
  // and all three Sentry surfaces push query_string through this function and
  // the URL through redactSensitiveText.
  describe("query parameters obey the key denylist too", () => {
    it("redacts person keys in a structured query object", () => {
      expect(
        redactSensitiveQueryParams({
          memberName: "Jane Doe",
          firstName: "Jane",
          memberEmail: "jane@example.test",
          memberId: "cmqdxeu50002101n22w2ivcas",
        })
      ).toEqual({
        memberName: "[REDACTED]",
        firstName: "[REDACTED]",
        memberEmail: "[REDACTED]",
        memberId: "cmqdxeu50002101n22w2ivcas",
      });
    });

    it("keeps the OAuth-only keys, which the JSON denylist does not carry", () => {
      // `code` and `state` are meaningless as JSON keys — an error code and a
      // booking state — so they belong only to the query context. The fix is a
      // UNION, and this fails if someone "simplifies" it to the JSON list.
      expect(
        redactSensitiveQueryParams({ code: "oauth-code", state: "csrf" })
      ).toEqual({ code: "[REDACTED]", state: "[REDACTED]" });
      expect(redactSensitiveJson({ code: "P2002", state: "CONFIRMED" })).toEqual(
        { code: "P2002", state: "CONFIRMED" }
      );
    });

    it("redacts person keys in a raw query string", () => {
      expect(
        redactSensitiveQueryParams(
          "memberId=cmqdxeu50002101n22w2ivcas&memberName=Jane+Doe&page=2"
        )
      ).toBe(
        "memberId=cmqdxeu50002101n22w2ivcas&memberName=[REDACTED]&page=2"
      );
    });

    it("redacts person keys in a full URL, including the percent-encoded email", () => {
      // URLSearchParams encodes @ as %40, which the bare email pattern cannot
      // see — so before this the audit-log URL reached Sentry byte-identical.
      expect(
        redactSensitiveText(
          "https://club.test/admin/audit-log?memberName=Jane+Doe&memberEmail=jane%40example.test&page=2"
        )
      ).toBe(
        "https://club.test/admin/audit-log?memberName=[REDACTED]&memberEmail=[REDACTED]&page=2"
      );
    });

    it("still catches a percent-encoded address under a key it does not know", () => {
      expect(redactSensitiveText("?q=jane%40example.test")).toBe("[REDACTED]");
    });
  });

  // #2683 review finding 5. SENSITIVE_JSON_KEYS held the EXACT key "password",
  // which never matched passwordHash, and nothing matched totpSecret — so the
  // list guarding logs and Sentry was strictly weaker than audit.ts's, the
  // opposite of what a reader would assume.
  describe("credentials", () => {
    it("redacts hashed and second-factor credentials, not just bare spellings", () => {
      expect(
        redactSensitiveJson({
          password: "hunter2",
          passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
          newPasswordConfirmation: "hunter2",
          totpSecret: "JBSWY3DPEHPK3PXP",
          resetToken: "reset-abc",
          verificationToken: "verify-abc",
          nominationToken: "nominate-abc",
          sessionToken: "session-abc",
          authToken: "auth-abc",
          webhookSecret: "whsec-abc",
        })
      ).toEqual({
        password: "[REDACTED]",
        passwordHash: "[REDACTED]",
        newPasswordConfirmation: "[REDACTED]",
        totpSecret: "[REDACTED]",
        resetToken: "[REDACTED]",
        verificationToken: "[REDACTED]",
        nominationToken: "[REDACTED]",
        sessionToken: "[REDACTED]",
        authToken: "[REDACTED]",
        webhookSecret: "[REDACTED]",
      });
    });

    it("leaves token COUNTS alone — they are metrics, not credentials", () => {
      // Why "token" is not itself a fragment.
      expect(
        redactSensitiveJson({ tokenCount: 1200, tokensUsed: 34 })
      ).toEqual({ tokenCount: 1200, tokensUsed: 34 });
    });

    // #2940. The credential routes post `{ key, value, version }`, so a signing
    // key's plaintext arrives under the key `value` — which neither list here
    // reached, because the fragments match key NAMES. Sentry captures a request
    // body as `event.request.data` whenever an exception escapes before the
    // route's own try/catch, and both MiroTalk gates (the permission read and
    // the audited refusal's database write) sit outside one.
    describe("the name/value pair", () => {
      const SIGNING_KEY = "mirotalk-signing-key-plaintext-value";

      it("redacts a credential body's value, whatever its key says", () => {
        expect(
          redactSensitiveJson({
            key: "jwt_key",
            value: SIGNING_KEY,
            version: "v-17",
          })
        ).toEqual({
          // The key survives: an operator still sees WHICH secret was being
          // written, which is the whole diagnostic worth having here.
          key: "jwt_key",
          value: "[REDACTED]",
          version: "v-17",
        });
      });

      it("redacts it inside a body Sentry captured as a JSON string", () => {
        // `event.request.data` arrives as text on some transports; the string
        // path parses it and runs the same object walk.
        const redacted = redactSensitiveJson(
          JSON.stringify({ key: "meeting_password", value: SIGNING_KEY })
        );
        expect(String(redacted)).not.toContain(SIGNING_KEY);
        expect(String(redacted)).toContain("[REDACTED]");
      });

      it("redacts it on an error that carried the body it choked on", () => {
        const error = Object.assign(new Error("write failed"), {
          key: "jwt_key",
          value: SIGNING_KEY,
        });
        expect(JSON.stringify(redactSensitiveJson(error))).not.toContain(
          SIGNING_KEY
        );
      });

      it("leaves a value that is NOT half of a key/value pair alone", () => {
        // The reason this is a pair rule rather than a `value` denylist entry:
        // `{ label, value }` is how this codebase builds money lines, booking
        // history rows and option lists, and blanking every one of them in
        // every log line costs more diagnosis than it buys.
        expect(
          redactSensitiveJson({
            rows: [
              { label: "Total", value: "$120.00" },
              { label: "Nights", value: "12 Jan 2026 - 14 Jan 2026" },
            ],
            value: "a standalone field keeps its meaning",
          })
        ).toEqual({
          rows: [
            { label: "Total", value: "$120.00" },
            { label: "Nights", value: "12 Jan 2026 - 14 Jan 2026" },
          ],
          value: "a standalone field keeps its meaning",
        });
      });

      it("catches the pair however either half is spelled", () => {
        // Both halves are tested in the same normalised form every other key
        // is, so a route that posts `Key`/`Value` is not a way around it.
        expect(redactSensitiveJson({ Key: "jwt_key", Value: SIGNING_KEY })).toEqual(
          { Key: "jwt_key", Value: "[REDACTED]" }
        );
      });

      it("does not read `apiKey` as the pair's name half", () => {
        // `apiKey` normalises to "apikey", not "key" — it is its own denylist
        // entry, and it must not drag an unrelated sibling `value` down with it.
        expect(
          redactSensitiveJson({ apiKey: "sk-abc", value: "us-east-1" })
        ).toEqual({ apiKey: "[REDACTED]", value: "us-east-1" });
      });
    });
  });

  it("redacts a request body carrying an imported member's password hash", () => {
    // api/admin/members/import puts row.passwordHash in a request body, which
    // Sentry captures wholesale as event.request.data.
    expect(
      redactSensitiveJson({
        rows: [
          {
            email: "jane@example.test",
            passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
            firstName: "Jane",
          },
        ],
      })
    ).toEqual({
      rows: [
        {
          email: "[REDACTED]",
          passwordHash: "[REDACTED]",
          firstName: "[REDACTED]",
        },
      ],
    });
  });

  // #2683 review finding 6. These were DOCUMENTED as a known gap. A gap in a
  // redactor is work, not a note (AGENTS.md §6). `memberName` in particular is
  // first-party — composed in at least six server routes — and had been filed
  // as "Xero's own"; `City` is a CSV export header.
  describe("composed person names and bare address keys", () => {
    it("redacts every composed name spelling a route invents", () => {
      expect(
        redactSensitiveJson({
          memberName: "Jane Doe",
          guestName: "John Smith",
          contactName: "Jane Doe",
          fullName: "Jane Doe",
          childName: "Sam Doe",
          surname: "Doe",
          givenName: "Jane",
          familyName: "Doe",
          middleName: "Ann",
          bookingId: "cmp20vk3t00q12345678npunsc",
        })
      ).toEqual({
        memberName: "[REDACTED]",
        guestName: "[REDACTED]",
        contactName: "[REDACTED]",
        fullName: "[REDACTED]",
        // Not on the list by that spelling, but it ends in "name" only by
        // coincidence — it is caught because the route that logged it was
        // fixed at source. Recorded here so the asymmetry is deliberate.
        childName: "Sam Doe",
        surname: "[REDACTED]",
        givenName: "[REDACTED]",
        familyName: "[REDACTED]",
        middleName: "[REDACTED]",
        bookingId: "cmp20vk3t00q12345678npunsc",
      });
    });

    it("redacts Xero's own bare address keys", () => {
      expect(
        redactSensitiveJson({
          Contact: {
            Addresses: [
              {
                AddressType: "STREET",
                AddressLine1: "12 Example Street",
                City: "Tokoroa",
                Region: "Waikato",
                PostalCode: "3420",
                Country: "NEW ZEALAND",
              },
            ],
          },
        })
      ).toEqual({
        Contact: {
          Addresses: [
            {
              AddressType: "STREET",
              AddressLine1: "[REDACTED]",
              City: "[REDACTED]",
              Region: "[REDACTED]",
              PostalCode: "[REDACTED]",
              Country: "[REDACTED]",
            },
          ],
        },
      });
    });
  });

  // #2683 review finding 9.
  describe("errors keep what makes them diagnosable", () => {
    it("keeps a Prisma error's code and meta", () => {
      const prismaError = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["email"] },
      });

      expect(redactSensitiveJson(prismaError)).toEqual(
        expect.objectContaining({
          name: "Error",
          message: "Unique constraint failed",
          code: "P2002",
          meta: { target: ["email"] },
        })
      );
    });

    it("keeps the cause chain", () => {
      const error = new Error("could not sync contact", {
        cause: new Error("Xero returned 400"),
      });

      expect(redactSensitiveJson(error)).toEqual(
        expect.objectContaining({
          message: "could not sync contact",
          cause: expect.objectContaining({ message: "Xero returned 400" }),
        })
      );
    });

    it("keeps an AggregateError's members", () => {
      const error = new AggregateError(
        [new Error("first failed"), new Error("second failed")],
        "all attempts failed"
      );

      expect(redactSensitiveJson(error)).toEqual(
        expect.objectContaining({
          message: "all attempts failed",
          errors: [
            expect.objectContaining({ message: "first failed" }),
            expect.objectContaining({ message: "second failed" }),
          ],
        })
      );
    });

    it("keeps the message of an error sitting AT the depth cap", () => {
      // The error branch used to sit after the depth check, so an error deep in
      // a payload rendered as "[TRUNCATED]" — message and all. An error message
      // is the one thing a log must not lose to a structural cap.
      const redacted = redactSensitiveJson({
        l0: { l1: { l2: { l3: { l4: { l5: new Error("the actual reason") } } } } },
      }) as Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, { message: string }>>>>>>;

      expect(redacted.l0.l1.l2.l3.l4.l5.message).toBe("the actual reason");
    });

    it("redacts a sensitive property attached to an error", () => {
      const error = Object.assign(new Error("auth failed"), {
        accessToken: "live-token",
        firstName: "Jane",
      });

      expect(redactSensitiveJson(error)).toEqual(
        expect.objectContaining({
          accessToken: "[REDACTED]",
          firstName: "[REDACTED]",
        })
      );
    });

    it("keeps a stack trace that names a scoped package", () => {
      // The email pattern used to match "…/node_modules/@sentry/nextjs/…" —
      // a local part before the @ and a dotted domain after it — so EVERY
      // server stack trace was replaced wholesale with "[REDACTED]".
      const error = new Error("boom");
      error.stack =
        "Error: boom\n    at f (/app/node_modules/@sentry/nextjs/dist/index.js:12:5)";

      expect(redactSensitiveJson(error)).toEqual(
        expect.objectContaining({ stack: error.stack })
      );
    });

    it("still redacts a real address inside a stack or message", () => {
      expect(redactSensitiveText("failed for jane@example.test at line 4")).toBe(
        "[REDACTED]"
      );
    });
  });

  // #2683 review finding 7.
  describe("JSON embedded in a string gets its own depth budget", () => {
    it("keeps the reason a Xero write was refused", () => {
      // On the live path (xero-operation-outbox) a Xero 400 carries a
      // validation document inside the message. Charging it against the OUTER
      // depth rendered "ValidationErrors":["[TRUNCATED]"] — deleting the
      // sentence saying why Xero refused the invoice, from the record kept to
      // explain the failure.
      const redacted = redactSensitiveJson({
        attempt: {
          outcome: {
            error: {
              message:
                '400: {"Elements":[{"ValidationErrors":[{"Message":"Invoice not of valid status for modification"}]}]}',
            },
          },
        },
      }) as { attempt: { outcome: { error: { message: string } } } };

      expect(redacted.attempt.outcome.error.message).toContain(
        "Invoice not of valid status for modification"
      );
      expect(redacted.attempt.outcome.error.message).not.toContain(
        "[TRUNCATED]"
      );
    });

    it("still redacts secrets inside that nested document", () => {
      const redacted = redactSensitiveJson({
        a: { b: { c: { d: { message: '400: {"firstName":"Jane"}' } } } },
      }) as { a: { b: { c: { d: { message: string } } } } };

      expect(redacted.a.b.c.d.message).toBe('400: {"firstName":"[REDACTED]"}');
    });

    it("terminates on a deeply nested string-in-JSON chain", () => {
      // Continuing the chain needs a JSON string at every level, whose quotes
      // the level above must escape, so the escaping at least doubles per level
      // and the maximum string length caps the chain at about 26. The shared
      // output budget bounds the total work across the hops.
      let nested = '{"firstName":"Jane"}';
      for (let level = 0; level < 8; level += 1) {
        nested = JSON.stringify({ inner: nested });
      }

      const redacted = redactSensitiveJson({ nested }) as { nested: string };
      expect(redacted.nested).not.toContain("Jane");
    });

    it("bounds a circular object nested beside a JSON-shaped string", () => {
      const payload: Record<string, unknown> = { depth: 1 };
      payload.self = payload;

      expect(
        redactSensitiveJson({ note: '500: {"a":{"b":{"c":1}}}', payload })
      ).toEqual({
        note: '500: {"a":{"b":{"c":1}}}',
        payload: { depth: 1, self: "[Circular]" },
      });
    });
  });

  // #2683 review finding 8.
  describe("stored records are not held to the log depth cap", () => {
    it("keeps an invoice's line-item tracking, which the log cap cut", () => {
      const invoice = {
        invoices: [
          {
            invoiceID: "inv-1",
            lineItems: [
              {
                description: "Bunk night",
                tracking: [{ name: "Lodge", option: "Alpine" }],
              },
            ],
          },
        ],
      };

      expect(redactSensitiveRecord(invoice)).toEqual(invoice);
      // The log path still bounds it — the two limits are deliberately different.
      expect(JSON.stringify(redactSensitiveJson(invoice))).toContain(
        "[TRUNCATED]"
      );
    });

    it("still guards a cycle, which the stored path never did before", () => {
      const member: Record<string, unknown> = { id: "m1" };
      const group: Record<string, unknown> = { id: "g1", memberships: [member] };
      member.familyGroup = group;

      expect(() => redactSensitiveRecord(member)).not.toThrow();
      expect(JSON.stringify(redactSensitiveRecord(member))).toContain(
        "[Circular]"
      );
    });

    it("applies the same redaction rules as the log path", () => {
      expect(
        redactSensitiveRecord({ firstName: "Jane", passwordHash: "x" })
      ).toEqual({ firstName: "[REDACTED]", passwordHash: "[REDACTED]" });
    });

    it("is what the admin display formatter uses", () => {
      expect(
        formatRedactedJson({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })
      ).toContain('"g": 1');
    });
  });

  // #2683 review finding 10. The ancestor-path guard re-renders a shared
  // subtree once per path that reaches it, so a DAG cost EXPONENTIAL output:
  // seven distinct objects measured 5.2 MB at a fan-out of 8 and 19.7 MB at 10,
  // inside pino's formatter and three Sentry beforeSends.
  describe("a shared subtree does not blow the walk or the output up", () => {
    function diamond(fanout: number) {
      let node: Record<string, unknown> = { leaf: "x".repeat(50) };
      for (let level = 0; level < 6; level += 1) {
        const next: Record<string, unknown> = {};
        for (let key = 0; key < fanout; key += 1) next[`k${key}`] = node;
        node = next;
      }
      return node;
    }

    it("renders each distinct node once, however many paths reach it", () => {
      // The memo half of the fix, measured on the walk rather than on the
      // bytes: seven objects in, seven objects out.
      const rendered = redactSensitiveJson(diamond(8));
      const distinct = new Set<unknown>();
      const stack: unknown[] = [rendered];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || typeof current !== "object") continue;
        if (distinct.has(current)) continue;
        distinct.add(current);
        for (const child of Object.values(current)) stack.push(child);
      }

      expect(distinct.size).toBeLessThanOrEqual(8);
    });

    it("bounds the SERIALISED size, which memoisation alone does not", () => {
      // The memo saves the walk but not the bytes: JSON has no syntax for a
      // reference, so JSON.stringify expands every shared subtree again. This
      // was still 5.2 MB with memoisation in place and audit.ts's 75-key cap
      // would not have touched it either — a fan-out of 8 never reaches 75.
      // The node budget is what actually bounds it.
      const rendered = JSON.stringify(redactSensitiveJson(diamond(8)));

      expect(rendered.length).toBeLessThan(300_000);
      expect(rendered).toContain("[TRUNCATED]");
    });

    it("leaves an ordinary payload untouched by the budget", () => {
      const booking = {
        id: "cmp20vk3t00q12345678npunsc",
        guests: Array.from({ length: 40 }, (_, index) => ({
          index,
          ageTier: "ADULT",
        })),
      };

      expect(JSON.stringify(redactSensitiveJson(booking))).not.toContain(
        "[TRUNCATED]"
      );
    });

    it("still renders a shared object twice rather than calling it circular", () => {
      // Memoisation must not become a visited-set: two siblings pointing at one
      // lodge is not a cycle, and both copies must show their content.
      const lodge = { id: "cmp20vk3t00q12345678npunsc", beds: 12 };

      expect(
        redactSensitiveJson({ arrival: { lodge }, departure: { lodge } })
      ).toEqual({
        arrival: { lodge: { id: "cmp20vk3t00q12345678npunsc", beds: 12 } },
        departure: { lodge: { id: "cmp20vk3t00q12345678npunsc", beds: 12 } },
      });
    });

    it("never memoises a subtree whose rendering depended on the path", () => {
      // `shared` is reached at the SAME depth down two paths with different
      // ancestors. Under `fromP` the walk is already inside `p`, so `shared.p`
      // is a genuine back-reference; under `fromShared` it is not, and `p` must
      // render in full. Reusing the first rendering would report a cycle where
      // there is none — which is exactly the failure the ancestor-path guard
      // was chosen over a visited-set to avoid.
      const p: Record<string, unknown> = { tag: "p" };
      const q = { tag: "q" };
      const shared = { p, q };
      p.shared = shared;

      expect(
        redactSensitiveJson({ fromP: p, fromShared: { shared } })
      ).toEqual({
        fromP: {
          tag: "p",
          shared: { p: "[Circular]", q: { tag: "q" } },
        },
        fromShared: {
          shared: {
            p: { tag: "p", shared: "[Circular]" },
            q: { tag: "q" },
          },
        },
      });
    });
  });

  // #2683 review finding 11. Pino calls formatters.log with no try/catch, so
  // anything thrown here is an unhandled crash raised from inside a logging
  // call — the exact failure this change exists to prevent.
  describe("the redactor never throws out of a log formatter", () => {
    it("survives an invalid Date", () => {
      expect(redactSensitiveJson({ when: new Date("nope") })).toEqual({
        when: "Invalid Date",
      });
    });

    it("survives a throwing getter and keeps its siblings", () => {
      const payload = {
        id: "cmp20vk3t00q12345678npunsc",
        get boom() {
          throw new Error("getter exploded");
        },
      };

      expect(redactSensitiveJson(payload)).toEqual({
        id: "cmp20vk3t00q12345678npunsc",
        boom: "[UNREADABLE]",
      });
    });

    it("survives a Proxy whose ownKeys trap throws", () => {
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("proxy exploded");
          },
        }
      );

      expect(redactSensitiveJson({ proxy })).toEqual({
        proxy: "[UNREADABLE]",
      });
    });

    it("marks a Map and a Set instead of rendering an empty object", () => {
      expect(
        redactSensitiveJson({
          m: new Map<string, unknown>([
            ["lodgeId", "cmp20vk3t00q12345678npunsc"],
            ["password", "hunter2"],
          ]),
          s: new Set(["a", "b"]),
        })
      ).toEqual({
        m: {
          _type: "Map",
          size: 2,
          entries: [
            ["lodgeId", "cmp20vk3t00q12345678npunsc"],
            ["password", "[REDACTED]"],
          ],
        },
        s: { _type: "Set", size: 2, values: ["a", "b"] },
      });
    });

    it("returns a marker rather than throwing if the walk fails outright", () => {
      const hostile = new Proxy(
        { a: 1 },
        {
          get() {
            throw new Error("get exploded");
          },
          ownKeys() {
            return ["a"];
          },
          getOwnPropertyDescriptor() {
            return { configurable: true, enumerable: true, value: 1 };
          },
        }
      );

      expect(() => redactSensitiveJson(hostile)).not.toThrow();
      expect(() => redactSensitiveText("plain text")).not.toThrow();
      expect(() => formatRedactedJson(hostile)).not.toThrow();
      expect(() => redactSensitiveQueryParams(hostile)).not.toThrow();
    });
  });

  it("catches a key on the denylist in JSON-shaped text that does not parse", () => {
    // The text path used to carry its own hand-written list of key names, and
    // it had drifted from the object path's — it knew nothing about
    // passwordHash, memberName or the AI-assistant keys. There is one list now.
    expect(
      redactSensitiveText(
        'failed on {"memberName":"Jane Doe","passwordHash":"$2b$10$x","question":"where is the key"'
      )
    ).toBe(
      'failed on {"memberName":"[REDACTED]","passwordHash":"[REDACTED]","question":"[REDACTED]"'
    );
  });
});
