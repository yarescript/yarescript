// yarescript's primitive type system, aka the seven (eight) kinds of thing a
// variable is allowed to be. Everything from the low-level numerics up to
// string is one of these. There is no `any` in this file and there never will
// be; that is the whole idea.

export type YType =
  | "void"
  | "int"
  | "long"
  | "float"
  | "double"
  | "bool"
  | "string"
  | "char";

export const PRIMITIVES: ReadonlySet<YType> = new Set([
  "void",
  "int",
  "long",
  "float",
  "double",
  "bool",
  "string",
  "char",
]);

export function isValidType(name: string): name is YType {
  return PRIMITIVES.has(name as YType);
}

// Numeric means "WebAssembly has an instruction for doing maths to it".
// `char` counts: it is an i32 with delusions of being a letter.
export function isNumeric(t: YType): boolean {
  return t === "int" || t === "long" || t === "float" || t === "double" || t === "char";
}

export function isInteger(t: YType): boolean {
  return t === "int" || t === "long" || t === "char";
}

export function isFloatLike(t: YType): boolean {
  return t === "float" || t === "double";
}

// Widening ranks. Numbers climb this ladder for free, one step at a time, and
// never slide back down without an explicit `->` cast. Gravity with paperwork.
const WIDEN_RANK: Record<YType, number> = {
  void: -1,
  bool: -1,
  string: -1,
  char: 0,
  int: 1,
  long: 2,
  float: 3,
  double: 4,
};

/** Can a value of type `from` be implicitly used where `to` is expected? */
export function isAssignable(from: YType, to: YType): boolean {
  if (from === to) return true;
  if (isNumeric(from) && isNumeric(to)) {
    return WIDEN_RANK[from] <= WIDEN_RANK[to];
  }
  return false;
}

/** Result type of combining two numeric operands (the wider of the two). */
export function widen(a: YType, b: YType): YType {
  if (a === b) return a;
  if (!isNumeric(a) || !isNumeric(b)) {
    throw new Error(`Cannot widen non-numeric types ${a} and ${b}`);
  }
  return WIDEN_RANK[a] >= WIDEN_RANK[b] ? a : b;
}

export function typeToWasmDescription(t: YType): string {
  switch (t) {
    case "int":
      return "i32";
    case "long":
      return "i64";
    case "float":
      return "f32";
    case "double":
      return "f64";
    case "bool":
      return "i32 (0|1)";
    case "char":
      return "i32 (one code unit)";
    case "string":
      return "i32 (pointer into linear memory)";
    case "void":
      return "void";
  }
}
