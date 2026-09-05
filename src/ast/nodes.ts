// AST definitions for the yarescript language.

export type Visibility = "public" | "private";

export interface TypeNode {
  name: string; // "int" | "float" | "bool" | "string" | "void" | user type name
  line: number;
  column: number;
}

export interface Param {
  name: string;
  paramType: TypeNode;
}

export type Node =
  | Program
  | FunctionDecl
  | VarDecl
  | Block
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | ExprStmt
  | ImportDecl
  | BinaryExpr
  | UnaryExpr
  | AssignExpr
  | CallExpr
  | Identifier
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | MemberExpr;

export interface Program {
  kind: "Program";
  body: (FunctionDecl | VarDecl | ImportDecl)[];
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
  varType: TypeNode;
  name: string;
  init: Expr | null;
  line: number;
}

export interface Block {
  kind: "Block";
  body: Stmt[];
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
  | ExprStmt;

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
  | MemberExpr;

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
  /** resolved by the checker: "host" for imported/builtin functions, "user" for yarescript functions */
  resolvedKind?: "host" | "user";
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
