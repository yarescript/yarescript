// yarescript's type system: the whole ladder, from a single byte up to a
// string. Every variable, parameter, and return value is one of these, and
// there is no `any` in this file, and there never will be.

export type YType =
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

export const PRIMITIVES: ReadonlySet<YType> = new Set([
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

/**
 * Signed and unsigned types widen inside their own family and never across it.
 * Turning a -1 into a very large positive number is the sort of thing a
 * programmer should have to type on purpose.
 */
export type TypeFamily = "signed" | "unsigned" | "float" | "other";

const FAMILY: Record<YType, TypeFamily> = {
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
  return FAMILY[t];
}

/** Position within a family. Ranks only mean anything next to their own kind. */
const RANK: Record<YType, number> = {
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

/** Smallest and largest value each integer type can hold. */
export const INT_RANGE: Partial<Record<YType, [number, number]>> = {
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

export function isValidType(name: string): name is YType {
  return PRIMITIVES.has(name as YType);
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

/** Can a value of type `from` be used where `to` is expected, with no cast? */
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
  return RANK[from] <= RANK[to];
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
  return RANK[a] >= RANK[b] ? a : b;
}

/** Result type of combining two numeric operands (the wider of the two). */
export function widen(a: YType, b: YType): YType {
  const result = tryWiden(a, b);
  if (!result) {
    throw new Error(`Cannot widen ${a} and ${b}`);
  }
  return result;
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
  }
}
