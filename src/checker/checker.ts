import * as N from "../ast/nodes";
import {
  INT_RANGE,
  PRIMITIVES,
  alignOfType,
  arrayOf,
  elemTypeOf,
  isArrayType,
  isAssignable,
  isInteger,
  isNumeric,
  ScalarType,
  sizeOfType,
  tryWiden,
  YType,
} from "./types";
import { didYouMean, suggest } from "../diagnostics/suggest";

/**
 * Names people reach for when they arrive from another language. A fuzzy match
 * cannot bridge "println" to "console.println", so the well-trodden paths get a
 * signpost instead.
 */
const COMMON_ALIASES: Record<string, string> = {
  "console.log": "console.println",
  log: "console.println",
  print: "console.println",
  printf: "console.println",
  println: "console.println",
  number: "double",
  str: "string",
  boolean: "bool",
  int32: "int",
  int64: "long",
  float64: "double",
  float32: "float",
};

export class TypeError_ extends Error {
  constructor(message: string, public line: number) {
    super(`Type error: ${message} (line ${line})`);
  }
}

interface FunctionSig {
  name: string;
  params: YType[];
  returnType: YType;
  visibility: N.Visibility;
}

/** A struct with its layout worked out, so codegen never has to guess. */
export interface StructInfo {
  name: string;
  fields: { name: string; type: YType; offset: number; size: number }[];
  /** total size in bytes, padding included */
  size: number;
}

interface HostFunctionSig {
  /** the name as called from yarescript, e.g. "console.println" */
  qualifiedName: string;
  /** accepted argument type -> the concrete host import name to emit */
  overloads: Partial<Record<YType, string>>;
  returnType: YType;
}

// The standard library available to every yarescript program without an
// explicit `import`. Batteries included, but the loader stays tiny: each of
// these compiles straight to a WASM host import instead of JS glue.
export const HOST_FUNCTIONS: Record<string, HostFunctionSig> = {
  "console.println": {
    qualifiedName: "console.println",
    overloads: {
      string: "console_println_string",
      bool: "console_println_bool",
      char: "console_println_char",
      i8: "console_println_int",
      i16: "console_println_int",
      int: "console_println_int",
      u8: "console_println_uint",
      u16: "console_println_uint",
      u32: "console_println_uint",
      long: "console_println_long",
      u64: "console_println_ulong",
      float: "console_println_float",
      double: "console_println_double",
    },
    returnType: "void",
  },
  // assert(false) throws inside the host, which traps the module. That is how
  // `yare test` finds out a test failed: loud, immediate, impossible to miss.
  assert: {
    qualifiedName: "assert",
    overloads: { bool: "assert" },
    returnType: "void",
  },
};

/**
 * The runtime reserves this prefix for the helpers codegen sneaks into your
 * module (string concat, the allocator, and friends). You may not have one.
 * It is nothing personal.
 */
export const RESERVED_PREFIX = "__yare_";

// A map of names with a pointer to its parent: the oldest trick in compiler
// writing, and still the best one anybody has come up with.
class Scope {
  private vars = new Map<string, { type: YType; isConst: boolean }>();
  constructor(public parent: Scope | null = null) {}

  declare(name: string, type: YType, isConst: boolean, line: number) {
    if (this.vars.has(name)) {
      throw new TypeError_(`Variable '${name}' is already declared in this scope`, line);
    }
    this.vars.set(name, { type, isConst });
  }

  lookup(name: string): { type: YType; isConst: boolean } | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  child(): Scope {
    return new Scope(this);
  }

  /** Every name visible from here, outer scopes included. */
  allNames(): string[] {
    const own = [...this.vars.keys()];
    return this.parent ? own.concat(this.parent.allNames()) : own;
  }
}

export interface CheckedProgram {
  program: N.Program;
  functions: Map<string, FunctionSig>;
  structs: Map<string, StructInfo>;
}

/**
 * Walks the AST, resolves every variable/function type, verifies
 * assignments & calls are legal, and annotates nodes with `inferredType`
 * so codegen never has to re-derive types.
 *
 * Everything codegen knows about types, it learned in here. So when codegen
 * throws something that smells like a type error, the real bug is usually
 * sitting upstream in this file, looking innocent.
 */
export class Checker {
  private functions = new Map<string, FunctionSig>();
  private structs = new Map<string, StructInfo>();

  check(program: N.Program): CheckedProgram {
    // Pass zero: structs, because every signature below is allowed to mention
    // one. A struct may only contain types that already exist, which is what
    // keeps a struct from containing itself and running out of universe.
    for (const decl of program.body) {
      if (decl.kind === "StructDecl") this.checkStructDecl(decl);
    }

    // First pass: collect function signatures so calls can be forward-referenced.
    for (const decl of program.body) {
      if (decl.kind === "FunctionDecl") {
        const returnType = this.resolveType(decl.returnType, decl.line);
        const params: YType[] = decl.params.map((p) => this.resolveType(p.paramType, decl.line));
        if (decl.name.startsWith(RESERVED_PREFIX)) {
          throw new TypeError_(
            `Function name '${decl.name}' is reserved for the yarescript runtime. Pick another.`,
            decl.line
          );
        }
        if (this.functions.has(decl.name)) {
          throw new TypeError_(`Function '${decl.name}' is already defined`, decl.line);
        }
        this.functions.set(decl.name, {
          name: decl.name,
          params,
          returnType,
          visibility: decl.visibility,
        });
      }
    }

    if (!this.functions.has("main")) {
      throw new TypeError_("Program has no 'main' function. Every yarescript program needs one.", 0);
    }

    const globalScope = new Scope();

    for (const decl of program.body) {
      if (decl.kind === "FunctionDecl") {
        this.checkFunction(decl, globalScope);
      } else if (decl.kind === "VarDecl") {
        this.checkVarDecl(decl, globalScope);
      }
      // ImportDecl: nothing to check yet (module resolution is a v2 feature).
    }

    return { program, functions: this.functions, structs: this.structs };
  }

  /**
   * Lays a struct out field by field, each at its natural alignment. The
   * result is the only place a field offset is ever computed, which is the
   * difference between a struct that works and one that works on Tuesdays.
   */
  private checkStructDecl(decl: N.StructDecl) {
    if (PRIMITIVES.has(decl.name as any)) {
      throw new TypeError_(`'${decl.name}' is a built-in type, so it cannot also be a struct`, decl.line);
    }
    if (this.structs.has(decl.name)) {
      throw new TypeError_(`Struct '${decl.name}' is already defined`, decl.line);
    }
    if (decl.name.startsWith(RESERVED_PREFIX)) {
      throw new TypeError_(
        `Struct name '${decl.name}' is reserved for the yarescript runtime. Pick another.`,
        decl.line
      );
    }
    if (!decl.fields.length) {
      throw new TypeError_(`Struct '${decl.name}' has no fields. An empty record holds nothing and costs a pointer.`, decl.line);
    }
    // Registered before its fields are read, so a struct can point at itself:
    // `struct Node { int value; Node[] next; }` is a list, and a list is a
    // reasonable thing to want. Every field is a pointer's worth of bytes, so
    // this cannot make the struct infinitely large.
    this.structs.set(decl.name, { name: decl.name, fields: [], size: 4 });
    const fields: StructInfo["fields"] = [];
    const seen = new Set<string>();
    let offset = 0;
    let widest = 1;
    for (const f of decl.fields) {
      if (seen.has(f.name)) {
        throw new TypeError_(`Struct '${decl.name}' has two fields called '${f.name}'`, decl.line);
      }
      seen.add(f.name);
      const type = this.resolveType(f.fieldType, decl.line);
      const align = alignOfType(type);
      offset = Math.ceil(offset / align) * align;
      const size = sizeOfType(type);
      fields.push({ name: f.name, type, offset, size });
      offset += size;
      widest = Math.max(widest, align);
    }
    // round the whole thing up so an array of these keeps every element aligned
    const size = Math.ceil(offset / widest) * widest;
    this.structs.set(decl.name, { name: decl.name, fields, size });
  }

  /**
   * Turns a written type into a real one. `int[]` becomes the string "int[]",
   * `Point` becomes "Point", and anything else gets an error with a suggestion
   * attached, because that is the part people actually read.
   */
  private resolveType(node: N.TypeNode, line: number): YType {
    const base = node.name;
    if (!PRIMITIVES.has(base as any) && !this.structs.has(base)) {
      const alias = COMMON_ALIASES[base.toLowerCase()];
      const hint = alias
        ? ` Did you mean '${alias}'?`
        : didYouMean(base, [...PRIMITIVES, ...this.structs.keys()]);
      throw new TypeError_(`Unknown type '${N.typeSpelling(node)}'.${hint}`, line);
    }
    if (base === "void" && node.dims > 0) {
      throw new TypeError_(`An array of 'void' holds nothing. Declare something with a size.`, line);
    }
    return N.typeSpelling(node);
  }

  private checkFunction(fn: N.FunctionDecl, outer: Scope) {
    const scope = outer.child();
    for (const p of fn.params) {
      scope.declare(p.name, this.resolveType(p.paramType, fn.line), false, fn.line);
    }
    const returnType = this.resolveType(fn.returnType, fn.line);
    const sawReturn = this.checkBlock(fn.body, scope, returnType);
    if (returnType !== "void" && !sawReturn) {
      throw new TypeError_(
        `Function '${fn.name}' must return a value of type '${returnType}' on every path`,
        fn.line
      );
    }
  }

  /**
   * A literal is allowed to land in any integer type it fits, including the
   * unsigned ones, so `let: u8 b = 200;` is not an error. Nothing else gets
   * that courtesy; a variable of type int is not secretly a u8.
   */
  private checkExprAs(expr: N.Expr, scope: Scope, target: YType): YType {
    // `[1, 2, 3]` has no type of its own; it takes the one it is being handed.
    if (expr.kind === "ArrayLiteral") {
      if (!isArrayType(target)) {
        throw new TypeError_(
          `Cannot put an array literal in something of type '${target}'. Declare an array type, e.g. let: int[] xs = [1, 2, 3];`,
          expr.line
        );
      }
      const elem = elemTypeOf(target);
      expr.elements.forEach((element, idx) => {
        const t = this.checkExprAs(element, scope, elem);
        if (!isAssignable(t, elem)) {
          throw new TypeError_(
            `Element ${idx + 1} of the array: expected '${elem}', got '${t}'`,
            expr.line
          );
        }
      });
      expr.inferredType = target;
      return target;
    }
    const t = this.checkExpr(expr, scope);
    if (isAssignable(t, target)) return t;
    const range = INT_RANGE[target as ScalarType];
    if (range) {
      const value = literalValueOf(expr);
      if (value !== null) {
        if (value < range[0] || value > range[1]) {
          throw new TypeError_(
            `${value} is out of range for '${target}' (it takes ${range[0]} to ${range[1]})`,
            expr.line
          );
        }
        // keep the inner literal in the target type too, so a negated one is
        // subtracted in the right width rather than in plain int
        if (expr.kind === "UnaryExpr") {
          (expr.argument as N.IntLiteral).inferredType = target;
        }
        expr.inferredType = target;
        return target;
      }
    }
    return t;
  }

  /**
   * A bare number literal borrows the type of its neighbour, so
   * `let: u8 i = 0; i = i + 2;` is arithmetic rather than a debate about
   * signedness. If the number does not fit, that is worth saying out loud.
   */
  private adoptLiteral(literal: N.Expr, nextTo: YType): YType | null {
    if (literal.kind !== "IntLiteral" || !isInteger(nextTo)) return null;
    const range = INT_RANGE[nextTo as ScalarType];
    if (!range || literal.value < range[0] || literal.value > range[1]) {
      throw new TypeError_(
        `${literal.value} is out of range for '${nextTo}'. Widen the other operand or use a cast.`,
        literal.line
      );
    }
    literal.inferredType = nextTo;
    return nextTo;
  }

  private checkVarDecl(decl: N.VarDecl, scope: Scope) {
    const declType = this.resolveType(decl.varType, decl.line);
    if (decl.init) {
      const initType = this.checkExprAs(decl.init, scope, declType);
      if (!isAssignable(initType, declType)) {
        throw new TypeError_(
          `Cannot assign '${initType}' to '${declType}' variable '${decl.name}'`,
          decl.line
        );
      }
    } else if (decl.isConst) {
      throw new TypeError_(`const '${decl.name}' must be initialized`, decl.line);
    }
    scope.declare(decl.name, declType, decl.isConst, decl.line);
  }

  /** Returns true if every path through the block returns a value. */
  private checkBlock(block: N.Block, outer: Scope, expectedReturn: YType): boolean {
    const scope = outer.child();
    let returns = false;
    for (const stmt of block.body) {
      if (this.checkStmt(stmt, scope, expectedReturn)) returns = true;
    }
    return returns;
  }

  private checkStmt(stmt: N.Stmt, scope: Scope, expectedReturn: YType): boolean {
    switch (stmt.kind) {
      case "VarDecl":
        this.checkVarDecl(stmt, scope);
        return false;
      case "Block":
        return this.checkBlock(stmt, scope, expectedReturn);
      case "ExprStmt":
        this.checkExpr(stmt.expression, scope);
        return false;
      case "ReturnStmt": {
        if (stmt.argument) {
          const t = this.checkExprAs(stmt.argument, scope, expectedReturn);
          if (!isAssignable(t, expectedReturn)) {
            throw new TypeError_(
              `Cannot return '${t}' from a function declared to return '${expectedReturn}'`,
              stmt.line
            );
          }
        } else if (expectedReturn !== "void") {
          throw new TypeError_(`Missing return value of type '${expectedReturn}'`, stmt.line);
        }
        return true;
      }
      case "IfStmt": {
        const t = this.checkExpr(stmt.test, scope);
        if (t !== "bool") throw new TypeError_(`'if' condition must be bool, got '${t}'`, stmt.line);
        const consReturns = this.checkBlock(stmt.consequent, scope, expectedReturn);
        let altReturns = false;
        if (stmt.alternate) {
          altReturns =
            stmt.alternate.kind === "IfStmt"
              ? this.checkStmt(stmt.alternate, scope, expectedReturn)
              : this.checkBlock(stmt.alternate, scope, expectedReturn);
        }
        return consReturns && altReturns;
      }
      case "WhileStmt": {
        const t = this.checkExpr(stmt.test, scope);
        if (t !== "bool") throw new TypeError_(`'while' condition must be bool, got '${t}'`, stmt.line);
        this.checkBlock(stmt.body, scope, expectedReturn);
        // `while (true)` with no way out is the end of the function as far as
        // "does every path return" is concerned. Parsers are full of them.
        const spins = stmt.test.kind === "BoolLiteral" && stmt.test.value === true;
        return spins && !this.breaksOut(stmt.body.body);
      }
      case "ForStmt": {
        const forScope = scope.child();
        if (stmt.init) {
          if (stmt.init.kind === "VarDecl") this.checkVarDecl(stmt.init, forScope);
          else this.checkExpr(stmt.init.expression, forScope);
        }
        if (stmt.test) {
          const t = this.checkExpr(stmt.test, forScope);
          if (t !== "bool") throw new TypeError_(`'for' condition must be bool, got '${t}'`, stmt.line);
        }
        if (stmt.update) this.checkExpr(stmt.update, forScope);
        this.checkBlock(stmt.body, forScope, expectedReturn);
        return false;
      }
      case "BreakStmt":
      case "ContinueStmt":
        return false;
    }
  }

  private checkExpr(expr: N.Expr, scope: Scope): YType {
    switch (expr.kind) {
      case "IntLiteral": {
        // A literal that does not fit an i32 becomes a long rather than
        // quietly wrapping around. Surprises belong in birthday parties, not
        // in number literals.
        const v = expr.value;
        if (v >= -2147483648 && v <= 2147483647) {
          expr.inferredType = "int";
          return "int";
        }
        if (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER) {
          expr.inferredType = "long";
          return "long";
        }
        throw new TypeError_(`Integer literal ${v} does not even fit in a 'long'`, expr.line);
      }
      case "FloatLiteral":
        expr.inferredType = "double";
        return "double";
      case "StringLiteral":
        expr.inferredType = "string";
        return "string";
      case "BoolLiteral":
        expr.inferredType = "bool";
        return "bool";
      case "Identifier": {
        const v = scope.lookup(expr.name);
        if (!v) {
          throw new TypeError_(
            `Unknown identifier '${expr.name}'.${didYouMean(expr.name, this.knownNames(scope))}`,
            expr.line
          );
        }
        expr.inferredType = v.type;
        return v.type;
      }
      case "IndexExpr": {
        const objType = this.checkExpr(expr.object, scope);
        const idxType = this.checkExpr(expr.index, scope);
        if (objType === "string") {
          if (!isInteger(idxType)) {
            throw new TypeError_(`A string index must be an integer, got '${idxType}'`, expr.line);
          }
          expr.inferredType = "char";
          return "char";
        }
        if (isArrayType(objType)) {
          if (!isInteger(idxType)) {
            throw new TypeError_(`An array index must be an integer, got '${idxType}'`, expr.line);
          }
          const elem = elemTypeOf(objType);
          expr.inferredType = elem;
          return elem;
        }
        throw new TypeError_(
          `Cannot index into a '${objType}'. Strings give you chars and arrays give you elements.`,
          expr.line
        );
      }
      case "MemberExpr": {
        const objType = this.checkExpr(expr.object, scope);
        if ((objType === "string" || isArrayType(objType)) && expr.property === "length") {
          expr.inferredType = "int";
          return "int";
        }
        const struct = this.structs.get(objType);
        if (struct) {
          const field = struct.fields.find((f) => f.name === expr.property);
          if (!field) {
            throw new TypeError_(
              `Struct '${objType}' has no field '${expr.property}'.${didYouMean(
                expr.property,
                struct.fields.map((f) => f.name)
              )}`,
              expr.line
            );
          }
          expr.inferredType = field.type;
          return field.type;
        }
        throw new TypeError_(
          `'${this.stringifyMember(expr)}' is not a value. Did you mean to call it?`,
          expr.line
        );
      }
      case "UnaryExpr": {
        if (expr.operator === "++" || expr.operator === "--") {
          const t = this.checkLvalue(expr.argument, scope, expr.line);
          if (!isNumeric(t)) {
            throw new TypeError_(`'${expr.operator}' needs something numeric to count, got '${t}'`, expr.line);
          }
          expr.inferredType = t;
          return t;
        }
        const t = this.checkExpr(expr.argument, scope);
        if (expr.operator === "!") {
          if (t !== "bool") throw new TypeError_(`'!' requires bool, got '${t}'`, expr.line);
          expr.inferredType = "bool";
          return "bool";
        }
        if (!isNumeric(t)) throw new TypeError_(`'${expr.operator}' requires a numeric type, got '${t}'`, expr.line);
        expr.inferredType = t;
        return t;
      }
      case "CastExpr": {
        const target = this.resolveType(expr.targetType, expr.line);
        if (isArrayType(target) || this.structs.has(target)) {
          throw new TypeError_(
            `Cannot cast to '${target}'. Arrays and structs are pointers, and a pointer is not a number.`,
            expr.line
          );
        }
        if (target === "void") {
          throw new TypeError_(`Cannot cast to 'void'. Use 'return;' if you want to stop here.`, expr.line);
        }
        const from = this.checkExpr(expr.expr, scope);
        if (isArrayType(from) || this.structs.has(from)) {
          throw new TypeError_(`Cannot cast a '${from}' to '${target}'.`, expr.line);
        }
        if (from === "string" || target === "string") {
          throw new TypeError_(
            `Cannot cast '${from}' to '${target}'. A string is a pointer plus a length, not a number.`,
            expr.line
          );
        }
        const bothNumeric = isNumeric(from) && isNumeric(target);
        const fromBool = from === "bool" && isNumeric(target);
        const toBool = target === "bool" && isNumeric(from);
        if (!bothNumeric && !fromBool && !toBool) {
          throw new TypeError_(`Cannot cast '${from}' to '${target}'`, expr.line);
        }
        // Narrowing is legal here because you typed the arrow yourself. If you
        // truncate 3.9 down to 3, that is a decision you made in public.
        expr.inferredType = target;
        return target;
      }
      case "BinaryExpr": {
        let lt = this.checkExpr(expr.left, scope);
        let rt = this.checkExpr(expr.right, scope);
        // a bare number takes the type of whatever it is standing next to
        const adoptedLeft = this.adoptLiteral(expr.left, rt);
        if (adoptedLeft) lt = adoptedLeft;
        const adoptedRight = this.adoptLiteral(expr.right, lt);
        if (adoptedRight) rt = adoptedRight;
        const comparisons = new Set(["==", "!=", "<", ">", "<=", ">="]);
        const logical = new Set(["&&", "||"]);
        if (logical.has(expr.operator)) {
          if (lt !== "bool" || rt !== "bool") {
            throw new TypeError_(`'${expr.operator}' requires bool operands, got '${lt}' and '${rt}'`, expr.line);
          }
          expr.inferredType = "bool";
          return "bool";
        }
        if (comparisons.has(expr.operator)) {
          if (lt === "string" && rt === "string") {
            // Ordering is byte order, which for UTF-8 is also code point order.
            // It is not a collation, and it does not pretend to be one.
            expr.inferredType = "bool";
            return "bool";
          } else if (isArrayType(lt) || isArrayType(rt) || this.structs.has(lt) || this.structs.has(rt)) {
            throw new TypeError_(
              `Cannot compare '${lt}' and '${rt}' with '${expr.operator}'. Two arrays with the same contents are still two arrays; compare them element by element.`,
              expr.line
            );
          } else if (isNumeric(lt) && isNumeric(rt)) {
            // fine
          } else if (lt === "bool" && rt === "bool") {
            if (expr.operator !== "==" && expr.operator !== "!=") {
              throw new TypeError_(`Only '==' and '!=' work on bools`, expr.line);
            }
          } else {
            throw new TypeError_(`Cannot compare '${lt}' and '${rt}'`, expr.line);
          }
          expr.inferredType = "bool";
          return "bool";
        }
        // arithmetic: + - * / %
        if (expr.operator === "+" && (lt === "string" || rt === "string")) {
          const other = lt === "string" ? rt : lt;
          if (other !== "string" && other !== "char") {
            throw new TypeError_(
              `Cannot mix 'string' with '${other}' in '+'. Turn it into text first with '-> char' or build it up from "".`,
              expr.line
            );
          }
          expr.inferredType = "string";
          return "string";
        }
        if (isArrayType(lt) || isArrayType(rt) || this.structs.has(lt) || this.structs.has(rt)) {
          throw new TypeError_(
            `'${expr.operator}' does not work on '${isArrayType(lt) ? lt : rt}'. Loop over the elements if you want to combine them.`,
            expr.line
          );
        }
        if (!isNumeric(lt) || !isNumeric(rt)) {
          throw new TypeError_(`'${expr.operator}' requires numeric operands, got '${lt}' and '${rt}'`, expr.line);
        }
        const result = tryWiden(lt, rt);
        if (!result) {
          throw new TypeError_(
            `Cannot use '${expr.operator}' on '${lt}' and '${rt}': one is signed and the other is not. Cast one of them.`,
            expr.line
          );
        }
        expr.inferredType = result;
        return result;
      }
      case "AssignExpr": {
        const targetType = this.checkLvalue(expr.target, scope, expr.line);
        if (expr.operator !== "=" && !isNumeric(targetType)) {
          throw new TypeError_(`'${expr.operator}' requires a numeric target, got '${targetType}'`, expr.line);
        }
        const valueType = this.checkExprAs(expr.value, scope, targetType);
        if (!isAssignable(valueType, targetType)) {
          throw new TypeError_(
            `Cannot assign '${valueType}' to '${targetType}' in '${this.describeLvalue(expr.target)}'`,
            expr.line
          );
        }
        expr.inferredType = targetType;
        return targetType;
      }
      case "ArrayLiteral":
        // Reached only when nothing told the literal what to be.
        throw new TypeError_(
          `An array literal needs an array type to aim at: let: int[] xs = [1, 2, 3];`,
          expr.line
        );
      case "NewArrayExpr": {
        const elem = this.resolveType(expr.elemType, expr.line);
        const sizeType = this.checkExprAs(expr.size, scope, "int");
        if (!isInteger(sizeType)) {
          throw new TypeError_(`An array size must be an integer, got '${sizeType}'`, expr.line);
        }
        const t = arrayOf(elem);
        expr.inferredType = t;
        return t;
      }
      case "CallExpr": {
        const calleeName = this.calleeName(expr.callee);
        if (calleeName && HOST_FUNCTIONS[calleeName]) {
          const sig = HOST_FUNCTIONS[calleeName];
          if (expr.args.length !== 1) {
            throw new TypeError_(`'${calleeName}' expects exactly 1 argument`, expr.line);
          }
          const argType = this.checkExpr(expr.args[0], scope);
          if (!sig.overloads[argType]) {
            throw new TypeError_(
              `'${calleeName}' does not support argument type '${argType}'`,
              expr.line
            );
          }
          expr.resolvedKind = "host";
          expr.inferredType = sig.returnType;
          return sig.returnType;
        }
        if (calleeName && this.structs.has(calleeName)) {
          // `Point(1, 2)` builds a Point. Positional, because a struct's fields
          // are already in an order and inventing a second one helps nobody.
          const struct = this.structs.get(calleeName)!;
          if (expr.args.length !== struct.fields.length) {
            throw new TypeError_(
              `Struct '${calleeName}' has ${struct.fields.length} field(s) (${struct.fields
                .map((f) => f.name)
                .join(", ")}), got ${expr.args.length} argument(s)`,
              expr.line
            );
          }
          expr.args.forEach((arg, idx) => {
            const field = struct.fields[idx];
            const t = this.checkExprAs(arg, scope, field.type);
            if (!isAssignable(t, field.type)) {
              throw new TypeError_(
                `Field '${field.name}' of '${calleeName}': expected '${field.type}', got '${t}'`,
                expr.line
              );
            }
          });
          expr.resolvedKind = "struct";
          expr.inferredType = calleeName;
          return calleeName;
        }
        if (calleeName && this.functions.has(calleeName)) {
          const sig = this.functions.get(calleeName)!;
          if (expr.args.length !== sig.params.length) {
            throw new TypeError_(
              `'${calleeName}' expects ${sig.params.length} argument(s), got ${expr.args.length}`,
              expr.line
            );
          }
          expr.args.forEach((arg, idx) => {
            const t = this.checkExprAs(arg, scope, sig.params[idx]);
            if (!isAssignable(t, sig.params[idx])) {
              throw new TypeError_(
                `Argument ${idx + 1} of '${calleeName}': expected '${sig.params[idx]}', got '${t}'`,
                expr.line
              );
            }
          });
          expr.resolvedKind = "user";
          expr.inferredType = sig.returnType;
          return sig.returnType;
        }
        throw new TypeError_(
          `Unknown function '${calleeName ?? "<expr>"}'.${this.functionHint(calleeName, scope)}`,
          expr.line
        );
      }
    }
  }

  /**
   * Whether a block breaks out of the loop it is sitting in. A `break` inside
   * a nested loop breaks that one instead, so nested loops are not descended
   * into, which is the only subtle thing about this function.
   */
  private breaksOut(stmts: N.Stmt[]): boolean {
    for (const stmt of stmts) {
      if (stmt.kind === "BreakStmt") return true;
      if (stmt.kind === "Block" && this.breaksOut(stmt.body)) return true;
      if (stmt.kind === "IfStmt") {
        if (this.breaksOut(stmt.consequent.body)) return true;
        const alt = stmt.alternate;
        if (alt && alt.kind === "IfStmt" && this.breaksOut([alt])) return true;
        if (alt && alt.kind === "Block" && this.breaksOut(alt.body)) return true;
      }
    }
    return false;
  }

  /** Everything a name could plausibly have been meant to be. */
  private knownNames(scope: Scope): string[] {
    return [...scope.allNames(), ...this.functions.keys(), ...Object.keys(HOST_FUNCTIONS)];
  }

  private typeHint(name: string): string {
    const alias = COMMON_ALIASES[name.toLowerCase()];
    if (alias) return ` Did you mean '${alias}'?`;
    return didYouMean(name, PRIMITIVES);
  }

  private functionHint(name: string | null, scope: Scope): string {
    if (!name) return "";
    const alias = COMMON_ALIASES[name.toLowerCase()];
    if (alias) return ` Did you mean '${alias}'?`;
    // 'prntln' is one keystroke from 'println', which is itself a signpost to
    // console.println, so a near miss on the alias still gets you there.
    const nearAlias = suggest(name, Object.keys(COMMON_ALIASES));
    if (nearAlias) return ` Did you mean '${COMMON_ALIASES[nearAlias]}'?`;
    return didYouMean(name, [...this.functions.keys(), ...Object.keys(HOST_FUNCTIONS)]);
  }

  /**
   * Everything you are allowed to write on the left of an `=`: a variable, an
   * array slot, or a struct field. Returns the type of the thing being written.
   */
  private checkLvalue(target: N.Expr, scope: Scope, line: number): YType {
    switch (target.kind) {
      case "Identifier": {
        const v = scope.lookup(target.name);
        if (!v) {
          throw new TypeError_(
            `Unknown identifier '${target.name}'.${didYouMean(target.name, this.knownNames(scope))}`,
            line
          );
        }
        if (v.isConst) throw new TypeError_(`Cannot assign to const '${target.name}'`, line);
        target.inferredType = v.type;
        return v.type;
      }
      case "IndexExpr":
      case "MemberExpr": {
        const base = target.object;
        if (base.kind === "Identifier") {
          const v = scope.lookup(base.name);
          if (v?.isConst) {
            throw new TypeError_(`Cannot write into const '${base.name}'`, line);
          }
        }
        return this.checkExpr(target, scope);
      }
      default:
        throw new TypeError_(
          `The left-hand side of an assignment has to be a variable, an array slot, or a struct field`,
          line
        );
    }
  }

  /** How to say what you were assigning to, in an error message. */
  private describeLvalue(target: N.Expr): string {
    switch (target.kind) {
      case "Identifier":
        return target.name;
      case "IndexExpr":
        return `${this.describeLvalue(target.object)}[...]`;
      case "MemberExpr":
        return `${this.describeLvalue(target.object)}.${target.property}`;
      default:
        return "<expression>";
    }
  }

  private calleeName(expr: N.Expr): string | null {
    if (expr.kind === "Identifier") return expr.name;
    if (expr.kind === "MemberExpr") {
      const base = this.calleeName(expr.object);
      return base ? `${base}.${expr.property}` : null;
    }
    return null;
  }

  private stringifyMember(expr: N.MemberExpr): string {
    const base = expr.object.kind === "Identifier" ? expr.object.name : "<expr>";
    return `${base}.${expr.property}`;
  }
}

/**
 * The value of a literal, including the ones written with a minus in front.
 * `-128` arrives as a unary expression on the number 128, which is a fine way
 * to parse it and a poor way to range check it.
 */
function literalValueOf(expr: N.Expr): number | null {
  if (expr.kind === "IntLiteral") return expr.value;
  if (expr.kind === "UnaryExpr" && expr.operator === "-" && expr.argument.kind === "IntLiteral") {
    return -expr.argument.value;
  }
  return null;
}

export function check(program: N.Program): CheckedProgram {
  return new Checker().check(program);
}
