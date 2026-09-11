// yarescript's primitive type system.
// Every variable/function, from "low level" (int, long, float raw numerics)
// to "high level" (string, bool), is one of these.

export type YType = "void" | "int" | "long" | "float" | "double" | "bool" | "string";

export const PRIMITIVES: ReadonlySet<YType> = new Set([
  "void",
  "int",
  "long",
  "float",
  "double",
  "bool",
  "string",
]);

export function isValidType(name: string): name is YType {
  return PRIMITIVES.has(name as YType);
}

export function isNumeric(t: YType): boolean {
  return t === "int" || t === "long" || t === "float" || t === "double";
}

export function isInteger(t: YType): boolean {
  return t === "int" || t === "long";
}

export function isFloatLike(t: YType): boolean {
  return t === "float" || t === "double";
}

// Rank used to figure out implicit widening: int -> long -> float -> double
const WIDEN_RANK: Record<YType, number> = {
  void: -1,
  bool: -1,
  string: -1,
  int: 0,
  long: 1,
  float: 2,
  double: 3,
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
    case "string":
      return "i32 (pointer into linear memory)";
    case "void":
      return "void";
  }
}
