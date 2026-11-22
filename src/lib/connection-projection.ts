/**
 * What an AI app connection is sent, as an allow-list (ALP-718, `INV-MCP-006`).
 *
 * A route the website also reads answers a connection with only the fields
 * its catalogue action promises (`McpAction.returns`). The shape names each
 * field it keeps; anything not named is dropped, so a field the website's
 * answer gains later never reaches an AI app by default.
 *
 * One projector for every route (`INV-SSOT`): `connectionJson` in
 * `mcp-connection-request.ts` applies it, and the catalogue describes each
 * action's answer with the same shape the route projects with.
 *
 * Pure and free of server imports, so the catalogue and the client-safe lib
 * modules that hold the shapes can import it.
 */

const EACH_ENTRY = Symbol("connection-shape.each-entry");

/** A map whose keys are data (dates, message keys): every entry is kept, each projected by `of`. */
export interface ConnectionShapeRecord {
  readonly [EACH_ENTRY]: ConnectionField;
}

/**
 * `true` keeps a plain value: a string, number, boolean, null, date, or an
 * array of those. A nested shape keeps an object, or each object in an array,
 * projected again. An object under `true` is dropped rather than passed whole.
 */
export type ConnectionField = true | ConnectionShape | ConnectionShapeRecord;

export interface ConnectionShape {
  readonly [key: string]: ConnectionField;
}

/** Keeps every entry of a map whose keys are data rather than field names. */
export function eachEntry(of: ConnectionField): ConnectionShapeRecord {
  return { [EACH_ENTRY]: of };
}

type Plain = string | number | boolean | null | Date;

type FieldFor<V, Complete extends boolean> = [NonNullable<V>] extends [Plain | ReadonlyArray<Plain>]
  ? true
  : NonNullable<V> extends ReadonlyArray<infer Item>
    ? ShapeFor<Item, Complete>
    : ShapeFor<NonNullable<V>, Complete> | ConnectionShapeRecord;

type ShapeFor<T, Complete extends boolean> = Complete extends true
  ? { readonly [K in keyof T]-?: FieldFor<T[K], Complete> }
  : { readonly [K in keyof T]?: FieldFor<T[K], Complete> };

/** A shape that may name only fields `T` has: a typo or a stale field is a type error. */
export type ConnectionShapeFor<T> = ShapeFor<T, false>;

/** A shape that must name every field `T` has, at every depth: for a route whose whole answer is the action's. */
export type CompleteConnectionShapeFor<T> = ShapeFor<T, true>;

/**
 * The members of a union of answers as one object type with every field any
 * member has, so a complete shape for a route with several success answers
 * must name the fields of each.
 */
export type EveryFieldOf<U> = {
  [K in U extends unknown ? keyof U : never]: U extends unknown ? (K extends keyof U ? U[K] : never) : never;
};

/** Checks a shape against the type it projects, at compile time only. */
export function connectionShapeFor<T>(shape: ConnectionShapeFor<T>): ConnectionShape {
  return shape as ConnectionShape;
}

/** As `connectionShapeFor`, but every field of `T` must be named. */
export function completeConnectionShapeFor<T>(shape: CompleteConnectionShapeFor<T>): ConnectionShape {
  return shape as ConnectionShape;
}

function isPlain(value: unknown): boolean {
  return (
    value === null ||
    value instanceof Date ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecordField(field: ConnectionField): field is ConnectionShapeRecord {
  return typeof field === "object" && EACH_ENTRY in field;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

const DROPPED = Symbol("connection-projection.dropped");

function projectField(value: unknown, field: ConnectionField): unknown {
  if (field === true) {
    if (isPlain(value)) return value;
    if (Array.isArray(value) && value.every(isPlain)) return value;
    return DROPPED;
  }
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const projected = projectField(item, field);
      return projected === DROPPED ? [] : [projected];
    });
  }
  if (!isObject(value)) return DROPPED;
  if (isRecordField(field)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const projected = projectField(inner, field[EACH_ENTRY]);
      if (projected !== DROPPED) out[key] = projected;
    }
    return out;
  }
  return projectObject(value, field);
}

function projectObject(value: Record<string, unknown>, shape: ConnectionShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const projected = projectField(value[key], field);
    if (projected !== DROPPED) out[key] = projected;
  }
  return out;
}

/**
 * `value` with every field the shape does not name removed, at every depth.
 * A value that is not an object projects to an empty object.
 */
export function projectForConnection(value: unknown, shape: ConnectionShape): Record<string, unknown> {
  return isObject(value) ? projectObject(value, shape) : {};
}
