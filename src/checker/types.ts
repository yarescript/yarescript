// yarescript's type system: the whole ladder, from a single byte up to a
// string, plus the two compound types that hold more than one value at a time.
// Every variable, parameter, and return value is one of these, and there is no
// `any` in this file, and there never will be.

/** The scalar types. A closed list, because WebAssembly only has so many. */
export type ScalarType =
  | "void"
  | "bool"
  | "string"
  | "i8"
  | "i16"
  | "char"
  | "int"
  | "long"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "float"
  | "double";

/**
 * Every type in the language. The scalars are a closed set; arrays are spelled
 * `int[]` and structs are spelled with their own name, and neither list can be
 * written down ahead of time. So a YType is a string that the checker has
 * already agreed to, and the helpers below are how you ask it questions.
 */
export type YType = ScalarType | (string & {});

export const PRIMITIVES: ReadonlySet<ScalarType> = new Set([
  "void",
  "bool",
  "string",
  "i8",
  "i16",
  "char",
  "int",
  "long",
  "u8",
  "u16",
  "u32",
  "u64",
  "float",
  "double",
]);

/** Is this one of the fourteen names WebAssembly has an opinion about? */
export function isScalarType(t: YType): t is ScalarType {
  return PRIMITIVES.has(t as ScalarType);
}

/** Arrays are spelled the way you type them: `int[]`, `string[][]`. */
export function isArrayType(t: YType): boolean {
  return t.endsWith("[]");
}

/** The element type of an array. `int[][]` gives you `int[]`. */
export function elemTypeOf(t: YType): YType {
  return t.slice(0, -2);
}

/** Spell an array of `elem`. */
export function arrayOf(elem: YType): YType {
  return `${elem}[]`;
}

/** How many `[]` are stacked on the end of this type. Scalars have none. */
export function arrayDims(t: YType): number {
  let dims = 0;
  while (t.endsWith("[]")) {
    t = elemTypeOf(t);
    dims++;
  }
  return dims;
}

/**
 * Signed and unsigned types widen inside their own family and never across it.
 * Turning a -1 into a very large positive number is the sort of thing a
 * programmer should have to type on purpose.
 *
 * Arrays and structs are `other`: they widen into nothing and accept nothing.
 */
export type TypeFamily = "signed" | "unsigned" | "float" | "other";

const FAMILY: Record<ScalarType, TypeFamily> = {
  void: "other",
  bool: "other",
  string: "other",
  i8: "signed",
  i16: "signed",
  char: "signed",
  int: "signed",
  long: "signed",
  u8: "unsigned",
  u16: "unsigned",
  u32: "unsigned",
  u64: "unsigned",
  float: "float",
  double: "float",
};

export function familyOf(t: YType): TypeFamily {
  return FAMILY[t as ScalarType] ?? "other";
}

/** Position within a family. Ranks only mean anything next to their own kind. */
const RANK: Record<ScalarType, number> = {
  void: -1,
  bool: -1,
  string: -1,
  i8: 0,
  i16: 1,
  char: 2,
  int: 3,
  long: 4,
  u8: 0,
  u16: 1,
  u32: 2,
  u64: 3,
  float: 0,
  double: 1,
};

function rankOf(t: YType): number {
  return RANK[t as ScalarType] ?? -1;
}

/** Smallest and largest value each integer type can hold. */
export const INT_RANGE: Partial<Record<ScalarType, [number, number]>> = {
  i8: [-128, 127],
  i16: [-32768, 32767],
  char: [0, 65535],
  int: [-2147483648, 2147483647],
  long: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  u64: [0, Number.MAX_SAFE_INTEGER],
};

export function isValidType(name: string): name is ScalarType {
  return PRIMITIVES.has(name as ScalarType);
}

// Numeric means "WebAssembly has an instruction for doing maths to it".
export function isNumeric(t: YType): boolean {
  return familyOf(t) !== "other";
}

export function isInteger(t: YType): boolean {
  const f = familyOf(t);
  return f === "signed" || f === "unsigned";
}

export function isSigned(t: YType): boolean {
  return familyOf(t) === "signed";
}

export function isUnsigned(t: YType): boolean {
  return familyOf(t) === "unsigned";
}

export function isFloatLike(t: YType): boolean {
  return familyOf(t) === "float";
}

/**
 * Can a value of type `from` be used where `to` is expected, with no cast?
 *
 * Compound types are invariant: an `int[]` is only ever an `int[]`. Widening
 * an array would mean rewriting every element, which is not what anybody
 * means when they hand you one.
 */
export function isAssignable(from: YType, to: YType): boolean {
  if (from === to) return true;
  const ff = familyOf(from);
  const tf = familyOf(to);
  if (ff === "other" || tf === "other") return false;
  // Any number is welcome where a float is expected; that is the one crossing
  // that never surprises anybody.
  if (tf === "float") return true;
  if (ff === "float") return false;
  if (ff !== tf) return false;
  return rankOf(from) <= rankOf(to);
}

/** Result type of combining two numeric operands, or null if they do not mix. */
export function tryWiden(a: YType, b: YType): YType | null {
  if (a === b) return a;
  const fa = familyOf(a);
  const fb = familyOf(b);
  if (fa === "other" || fb === "other") return null;
  if (fa === "float" && fb === "float") return a === "double" || b === "double" ? "double" : "float";
  if (fa === "float") return a;
  if (fb === "float") return b;
  if (fa !== fb) return null;
  return rankOf(a) >= rankOf(b) ? a : b;
}

/** Result type of combining two numeric operands (the wider of the two). */
export function widen(a: YType, b: YType): YType {
  const result = tryWiden(a, b);
  if (!result) {
    throw new Error(`Cannot widen ${a} and ${b}`);
  }
  return result;
}

/**
 * How many bytes a value of this type occupies inside an array or a struct.
 * The narrow types get their real width, which is what makes `u8[]` an actual
 * array of bytes rather than an array of opinions.
 */
export function sizeOfType(t: YType): number {
  switch (t) {
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
    case "char":
      return 2;
    case "long":
    case "u64":
    case "double":
      return 8;
    default:
      // int, u32, bool, float, and every pointer (string, array, struct)
      return 4;
  }
}

/** The alignment a value of this type wants. Natural, which is also cheapest. */
export function alignOfType(t: YType): number {
  return sizeOfType(t);
}

export function typeToWasmDescription(t: YType): string {
  switch (t) {
    case "i8":
      return "i32 (sign extended from 8 bits)";
    case "i16":
      return "i32 (sign extended from 16 bits)";
    case "char":
      return "i32 (one code unit)";
    case "int":
      return "i32";
    case "u8":
    case "u16":
      return "i32 (zero extended)";
    case "u32":
      return "i32 (unsigned)";
    case "long":
      return "i64";
    case "u64":
      return "i64 (unsigned)";
    case "float":
      return "f32";
    case "double":
      return "f64";
    case "bool":
      return "i32 (0|1)";
    case "string":
      return "i32 (pointer into linear memory)";
    case "void":
      return "void";
    default:
      return isArrayType(t)
        ? "i32 (pointer to a length-prefixed array)"
        : "i32 (pointer to a struct)";
  }
}
