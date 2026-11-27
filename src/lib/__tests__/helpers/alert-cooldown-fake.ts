/**
 * An in-memory `prisma.alertCooldown` (#5255) that honours the `where` clauses
 * the once-ever claim, its give-back, its confirm and the sweep send, so a
 * suite can drive the real `alert-cooldown.ts` and see which rows a sequence
 * leaves behind. Not a general Prisma fake: it knows equality, `null`, `in`,
 * `lt`/`lte`/`gt`/`gte` (on dates and strings), `not`, a top-level `OR`, an
 * `exactPrefix` `startsWith`, and `orderBy` as one field or a list of them.
 *
 * `intercept(op, fn)` queues a one-shot wrapper for the next call of `op`:
 * `fn(run)` decides whether the write lands (`await run()`) and what the
 * caller sees, which is how a write that commits and then throws, or one that
 * commits only later, is modelled.
 */
type Row = {
  key: string;
  lastAlertedAt: Date;
  awaitingSendSince: Date | null;
  replayAlert: unknown;
};
type Op = "create" | "updateMany" | "deleteMany" | "findMany" | "findUnique";
type Interceptor = (run: () => Promise<unknown>) => Promise<unknown>;
type Where = Record<string, unknown>;

function asTime(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition === null) return actual === null;
  if (condition instanceof Date) return asTime(actual) === condition.getTime();
  if (typeof condition !== "object") return actual === condition;
  const ops = condition as Record<string, unknown>;
  return Object.entries(ops).every(([op, operand]) => {
    const a = actual instanceof Date ? actual.getTime() : actual;
    const b = operand instanceof Date ? operand.getTime() : operand;
    switch (op) {
      case "in":
        return (operand as unknown[]).includes(actual);
      case "not":
        return !matchesValue(actual, operand);
      case "lt":
        return a !== null && (a as number) < (b as number);
      case "lte":
        return a !== null && (a as number) <= (b as number);
      case "gt":
        return a !== null && (a as number) > (b as number);
      case "gte":
        return a !== null && (a as number) >= (b as number);
      case "startsWith":
        // `exactPrefix` escapes LIKE's metacharacters with a backslash.
        return typeof actual === "string" && actual.startsWith((operand as string).replace(/\\(.)/g, "$1"));
      default:
        throw new Error(`alert-cooldown fake: unsupported operator ${op}`);
    }
  });
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([field, condition]) =>
    field === "OR"
      ? (condition as Where[]).some((branch) => matches(row, branch))
      : matchesValue(row[field as keyof Row], condition),
  );
}

function compareField(a: unknown, b: unknown): number {
  const x = asTime(a) ?? a;
  const y = asTime(b) ?? b;
  if (x === y) return 0;
  return (x as number) < (y as number) ? -1 : 1;
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((field) => select[field]).map((field) => [field, row[field as keyof Row]]));
}

export function createAlertCooldownFake() {
  const rows = new Map<string, Row>();
  const interceptors = new Map<Op, Interceptor[]>();

  async function call<T>(op: Op, run: () => Promise<T>): Promise<T> {
    const next = interceptors.get(op)?.shift();
    return (next ? next(run) : run()) as Promise<T>;
  }

  const delegate = {
    async create({ data }: { data: Partial<Row> & { key: string; lastAlertedAt: Date } }) {
      return call("create", async () => {
        if (rows.has(data.key)) throw Object.assign(new Error("Unique constraint failed on the fields: (`key`)"), { code: "P2002" });
        const row: Row = { awaitingSendSince: null, replayAlert: null, ...data };
        rows.set(data.key, row);
        return { ...row };
      });
    },
    async updateMany({ where, data }: { where: Where; data: Partial<Row> }) {
      return call("updateMany", async () => {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      });
    },
    async deleteMany({ where }: { where: Where }) {
      return call("deleteMany", async () => {
        let count = 0;
        for (const [key, row] of [...rows]) {
          if (!matches(row, where)) continue;
          rows.delete(key);
          count += 1;
        }
        return { count };
      });
    },
    async findMany({
      where,
      select,
      orderBy,
      take,
    }: {
      where?: Where;
      select?: Record<string, boolean>;
      orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];
      take?: number;
    }) {
      return call("findMany", async () => {
        let found = [...rows.values()].filter((row) => matches(row, where));
        const order = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((entry) => Object.entries(entry));
        if (order.length > 0) {
          found = found.sort((a, b) => {
            for (const [field, direction] of order) {
              const sign = direction === "desc" ? -1 : 1;
              const diff = compareField(a[field as keyof Row], b[field as keyof Row]);
              if (diff !== 0) return sign * diff;
            }
            return 0;
          });
        }
        return found.slice(0, take ?? found.length).map((row) => pick(row, select));
      });
    },
    async findUnique({ where, select }: { where: { key: string }; select?: Record<string, boolean> }) {
      return call("findUnique", async () => {
        const row = rows.get(where.key);
        return row ? pick(row, select) : null;
      });
    },
  };

  return {
    rows,
    delegate,
    /** The `store` argument `alert-cooldown.ts`'s helpers take. */
    store: { alertCooldown: delegate } as never,
    intercept(op: Op, fn: Interceptor) {
      interceptors.set(op, [...(interceptors.get(op) ?? []), fn]);
    },
    reset() {
      rows.clear();
      interceptors.clear();
    },
  };
}

export type AlertCooldownFake = ReturnType<typeof createAlertCooldownFake>;
