// AST definitions for the yarescript language.
//
// Every node carries the line it came from, because "type error" on its own is
// a riddle and "type error on line 42" is something you can actually fix.

export type Visibility = "public" | "private";

export interface TypeNode {
  /** the base name: "int", "Point". For `int[]` this is still "int". */
  name: string;
  /** how many `[]` follow the name. `int` is 0, `int[]` is 1, `int[][]` is 2. */
  dims: number;
  line: number;
  column: number;
}

/** The spelling you would type: `int`, `Point`, `string[]`. */
export function typeSpelling(t: TypeNode): string {
  return t.name + "[]".repeat(t.dims);
}

export interface Param {
  name: string;
  paramType: TypeNode;
}

export type Node =
  | Program
  | FunctionDecl
  | StructDecl
  | VarDecl
  | Block
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | ExprStmt
  | SwitchStmt
  | SwitchCase
  | DoWhileStmt
  | ForOfStmt
  | ForInStmt
  | ImportDecl
  | DirectiveDecl
  | BinaryExpr
  | UnaryExpr
  | AssignExpr
  | CallExpr
  | Identifier
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | MemberExpr
  | CastExpr
  | IndexExpr
  | ArrayLiteral
  | NewArrayExpr
  | ConditionalExpr
  | TemplateExpr
  | NullLiteral
  | TypeOfExpr;

/** `a ? b : c`. Both arms are checked to a common type. */
export interface ConditionalExpr {
  kind: "ConditionalExpr";
  test: Expr;
  consequent: Expr;
  alternate: Expr;
  line: number;
  inferredType?: string;
}

/**
 * A backtick string. `parts` alternates between literal text and interpolated
 * expressions, starting and ending with text, so an empty literal is `[""]`.
 */
export interface TemplateExpr {
  kind: "TemplateExpr";
  parts: (string | Expr)[];
  line: number;
  inferredType?: string;
}

/** `null`, which only ever lands in a reference: an array, a struct, a string. */
export interface NullLiteral {
  kind: "NullLiteral";
  line: number;
  inferredType?: string;
}

/** `typeof x`, which is the type as the compiler knows it, at compile time. */
export interface TypeOfExpr {
  kind: "TypeOfExpr";
  argument: Expr;
  line: number;
  /** the type the checker found, which is what codegen prints */
  argumentType?: string;
  inferredType?: string;
}

export interface Program {
  kind: "Program";
  body: (FunctionDecl | StructDecl | VarDecl | ImportDecl | DirectiveDecl)[];
}

/**
 * A fixed-layout record: `struct Point { int x; int y; }`.
 *
 * Fields are laid out in the order you wrote them, each at its natural size,
 * which is exactly what makes them cheap: a struct is a pointer and some
 * offsets, with no reflection and no surprises.
 */
export interface StructDecl {
  kind: "StructDecl";
  name: string;
  fields: { name: string; fieldType: TypeNode }[];
  line: number;
  /** line of the closing brace, which `yare fmt` needs to place comments */
  endLine: number;
}

/**
 * A compiler directive: `@modules.import("json")`.
 *
 * Directives talk to the build, not to the program. They are the only place
 * yarescript borrows punctuation from the decorator world, and they are
 * deliberately few: `modules.import` is the whole list today.
 */
export interface DirectiveDecl {
  kind: "DirectiveDecl";
  namespace: string;
  action: string;
  args: string[];
  line: number;
}

export interface ImportDecl {
  kind: "ImportDecl";
  names: string[];
  from: string;
  line: number;
}

export interface FunctionDecl {
  kind: "FunctionDecl";
  name: string;
  visibility: Visibility;
  returnType: TypeNode;
  params: Param[];
  body: Block;
  line: number;
}

export interface VarDecl {
  kind: "VarDecl";
  isConst: boolean;
  /**
   * Null when you left it off, as in `let x = 5;`. The type checker works it
   * out from the initializer and writes the answer back here, so everything
   * downstream of checking sees a concrete type.
   */
  varType: TypeNode | null;
  name: string;
  init: Expr | null;
  line: number;
}

export interface Block {
  kind: "Block";
  body: Stmt[];
  /** line of the opening brace, which `yare fmt` needs to place comments */
  line: number;
  /** line of the closing brace, which `yare fmt` needs to keep your spacing */
  endLine: number;
}

export type Stmt =
  | VarDecl
  | Block
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | ExprStmt
  | SwitchStmt
  | DoWhileStmt
  | ForOfStmt
  | ForInStmt;

export interface IfStmt {
  kind: "IfStmt";
  test: Expr;
  consequent: Block;
  alternate: Block | IfStmt | null;
  line: number;
}

export interface WhileStmt {
  kind: "WhileStmt";
  test: Expr;
  body: Block;
  line: number;
}

export interface ForStmt {
  kind: "ForStmt";
  init: VarDecl | ExprStmt | null;
  test: Expr | null;
  update: Expr | null;
  body: Block;
  line: number;
}

/** `switch (n) { case 1: ... default: ... }`. Cases fall through until `break`. */
export interface SwitchStmt {
  kind: "SwitchStmt";
  discriminant: Expr;
  cases: SwitchCase[];
  line: number;
  /** line of the closing brace, which is what the formatter measures from */
  endLine: number;
}

export interface SwitchCase {
  kind: "SwitchCase";
  /** null on the `default:` case */
  test: Expr | null;
  consequent: Stmt[];
  /** line of the `case` or `default` keyword itself */
  line: number;
}

/** `do { ... } while (c);`, which runs the body once before asking. */
export interface DoWhileStmt {
  kind: "DoWhileStmt";
  test: Expr;
  body: Block;
  line: number;
  /** line the trailing semicolon sits on */
  endLine: number;
}

/** `for (let: string s of xs)`, over an array or the chars of a string. */
export interface ForOfStmt {
  kind: "ForOfStmt";
  /** null when the loop variable already exists */
  itemType: TypeNode | null;
  name: string;
  iterable: Expr;
  body: Block;
  line: number;
}

/** `for (let: int i in xs)`, over the indices of an array or a string. */
export interface ForInStmt {
  kind: "ForInStmt";
  indexType: TypeNode | null;
  name: string;
  iterable: Expr;
  body: Block;
  line: number;
}

export interface ReturnStmt {
  kind: "ReturnStmt";
  argument: Expr | null;
  line: number;
}

export interface BreakStmt {
  kind: "BreakStmt";
  line: number;
}

export interface ContinueStmt {
  kind: "ContinueStmt";
  line: number;
}

export interface ExprStmt {
  kind: "ExprStmt";
  expression: Expr;
  line: number;
}

export type Expr =
  | BinaryExpr
  | UnaryExpr
  | AssignExpr
  | CallExpr
  | Identifier
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | MemberExpr
  | CastExpr
  | IndexExpr
  | ArrayLiteral
  | NewArrayExpr
  | ConditionalExpr
  | TemplateExpr
  | NullLiteral
  | TypeOfExpr;

export interface BinaryExpr {
  kind: "BinaryExpr";
  operator: string;
  left: Expr;
  right: Expr;
  line: number;
  /** filled in by the type checker */
  inferredType?: string;
}

export interface UnaryExpr {
  kind: "UnaryExpr";
  operator: string;
  argument: Expr;
  prefix: boolean;
  line: number;
  inferredType?: string;
}

export interface AssignExpr {
  kind: "AssignExpr";
  operator: string; // = , += , -= , *= , /=
  target: Expr;
  value: Expr;
  line: number;
  inferredType?: string;
}

export interface CallExpr {
  kind: "CallExpr";
  callee: Expr;
  args: Expr[];
  line: number;
  inferredType?: string;
  /**
   * resolved by the checker: "host" for imported/builtin functions, "user" for
   * yarescript functions, "struct" for `Point(1, 2)`, which looks exactly like
   * a call and is not one.
   */
  resolvedKind?: "host" | "user" | "struct";
}

/**
 * An explicit cast: `expr -> TYPE`.
 * This is the only way to narrow a number, so if you lose precision it is
 * because you typed the arrow yourself.
 */
export interface CastExpr {
  kind: "CastExpr";
  expr: Expr;
  targetType: TypeNode;
  line: number;
  inferredType?: string;
}

/**
 * Indexing: `name[i]`. On a string this reads one char, with a bounds check
 * that traps rather than reading your neighbour's bytes.
 */
export interface IndexExpr {
  kind: "IndexExpr";
  object: Expr;
  index: Expr;
  line: number;
  inferredType?: string;
}

/**
 * An array literal: `[1, 2, 3]`. The element type comes from wherever the
 * literal is going, so the checker fills it in rather than guessing here.
 */
export interface ArrayLiteral {
  kind: "ArrayLiteral";
  elements: Expr[];
  line: number;
  inferredType?: string;
}

/** A sized, zero-filled array: `new int[5]`. */
export interface NewArrayExpr {
  kind: "NewArrayExpr";
  elemType: TypeNode;
  size: Expr;
  line: number;
  inferredType?: string;
}

export interface MemberExpr {
  kind: "MemberExpr";
  object: Expr;
  property: string;
  line: number;
  inferredType?: string;
}

export interface Identifier {
  kind: "Identifier";
  name: string;
  line: number;
  inferredType?: string;
}

export interface IntLiteral {
  kind: "IntLiteral";
  value: number;
  line: number;
  inferredType?: string;
}

export interface FloatLiteral {
  kind: "FloatLiteral";
  value: number;
  line: number;
  inferredType?: string;
}

export interface StringLiteral {
  kind: "StringLiteral";
  value: string;
  line: number;
  inferredType?: string;
}

export interface BoolLiteral {
  kind: "BoolLiteral";
  value: boolean;
  line: number;
  inferredType?: string;
}
