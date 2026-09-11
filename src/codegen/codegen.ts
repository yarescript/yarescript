import binaryen = require("binaryen");
import * as N from "../ast/nodes";
import { CheckedProgram, HOST_FUNCTIONS } from "../checker/checker";
import { isNumeric, widen, YType } from "../checker/types";

/**
 * Lowers a type-checked yarescript AST straight to a WebAssembly module
 * using binaryen. This is the whole point of the language: no JS emitted
 * here, ever. The only JS yarescript produces is the tiny host-side loader
 * (see src/runtime/loader-template.ts) that instantiates this module and hands it
 * a handful of host functions (console.log, etc).
 *
 * If you ever find this file emitting JavaScript, stop reading and file a bug:
 * that is the one promise the language makes, and it does not get to be
 * approximate.
 */

const PAGE_SIZE = 65536;

function wasmType(t: YType): number {
  switch (t) {
    case "int":
      return binaryen.i32;
    case "bool":
      return binaryen.i32;
    case "long":
      return binaryen.i64;
    case "float":
      return binaryen.f32;
    case "double":
      return binaryen.f64;
    case "string":
      // strings are represented as an i32 pointer into linear memory
      // pointing at a `[u32 length][utf8 bytes...]` block.
      return binaryen.i32;
    case "char":
      // a char is an i32 that has read too many novels
      return binaryen.i32;
    case "void":
      return binaryen.none;
  }
}

interface LocalInfo {
  index: number;
  type: YType;
}

class FunctionScope {
  private locals = new Map<string, LocalInfo>();
  public localTypes: number[] = [];
  private nextIndex: number;

  constructor(paramTypes: YType[]) {
    this.nextIndex = paramTypes.length;
  }

  declareParam(name: string, index: number, type: YType) {
    this.locals.set(name, { index, type });
  }

  declareLocal(name: string, type: YType): number {
    const index = this.nextIndex++;
    this.locals.set(name, { index, type });
    this.localTypes.push(wasmType(type));
    return index;
  }

  lookup(name: string): LocalInfo {
    const info = this.locals.get(name);
    if (!info) throw new Error(`codegen: unresolved identifier '${name}' (checker should have caught this)`);
    return info;
  }

  child(): FunctionScope {
    // yarescript blocks share the flat local index space (like most
    // stack machines / wasm functions do); only variable *names* get forked.
    const s = Object.create(FunctionScope.prototype) as FunctionScope;
    s.locals = new Map(this.locals);
    s.localTypes = this.localTypes;
    s.nextIndex = this.nextIndex;
    const self = this;
    // keep nextIndex/localTypes shared by reference semantics via closures
    Object.defineProperty(s, "nextIndex", {
      get: () => self.nextIndex,
      set: (v) => (self.nextIndex = v),
    });
    return s;
  }
}

export interface CompileResult {
  wasmBinary: Uint8Array;
  wat: string;
  usedHostFunctions: string[];
  stringConstants: string[];
}

export function generateWasm(checked: CheckedProgram): CompileResult {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);

  const stringConstants: string[] = [];
  const stringOffsets = new Map<string, number>();
  const usedHostFunctions = new Set<string>();

  // ---- Memory & string table ----
  // yarescript's minimal runtime layout: linear memory starts with a table
  // of string constants (length-prefixed UTF-8), one page is plenty for
  // a hello-world and grows automatically for bigger programs.
  const segments: { offset: number; data: Uint8Array }[] = [];
  let heapCursor = 8; // leave the first bytes as a null-string guard

  // Unnamed block helper. binaryen's typings insist a block always has a
  // label, and most of ours do not care about having one.
  const blk = (children: number[], type: number = binaryen.auto) =>
    (mod.block as any)(null, children, type) as number;

  // The string runtime is installed on demand, and the heap cursor global
  // cannot be created until the string table's final size is known, which is
  // after every function has been compiled. Order of operations, in code as
  // in life.
  const HEAP_GLOBAL = "__yare_heap";
  let stringRuntimeInstalled = false;

  function internString(value: string): number {
    if (stringOffsets.has(value)) return stringOffsets.get(value)!;
    const bytes = Buffer.from(value, "utf8");
    const buf = Buffer.alloc(4 + bytes.length);
    buf.writeUInt32LE(bytes.length, 0);
    bytes.copy(buf, 4);
    const offset = heapCursor;
    segments.push({ offset, data: new Uint8Array(buf) });
    heapCursor += buf.length;
    // align to 4 bytes for tidy layout
    heapCursor = (heapCursor + 3) & ~3;
    stringOffsets.set(value, offset);
    stringConstants.push(value);
    return offset;
  }

  // ---- Host imports (console.log overloads etc.) ----
  function importHostFunction(name: string, params: number[], result: number) {
    if (usedHostFunctions.has(name)) return;
    usedHostFunctions.add(name);
    mod.addFunctionImport(name, "env", name, binaryen.createType(params), result);
  }

  // Always import the string-print host fn signature lazily as needed.
  for (const decl of checked.program.body) {
    if (decl.kind === "FunctionDecl") {
      scanCallsForHostImports(decl.body);
    }
  }

  function scanCallsForHostImports(node: N.Node): void {
    walk(node, (n) => {
      if (n.kind === "CallExpr" && n.resolvedKind === "host") {
        const calleeName = calleeQualifiedName(n.callee);
        const sig = HOST_FUNCTIONS[calleeName!];
        const argType = (n.args[0] as any).inferredType as YType;
        const hostName = sig.overloads[argType]!;
        importHostFunction(hostName, [wasmType(argType)], wasmType(sig.returnType));
      }
    });
  }

  // ---- Compile each function ----
  const exportedNames: string[] = [];
  const loopStack: { breakLabel: string; continueLabel: string }[] = [];
  // Return statements are widened to whatever the enclosing function promised
  // to return, so this follows the current function around.
  let currentReturnType: YType = "void";

  for (const decl of checked.program.body) {
    if (decl.kind !== "FunctionDecl") continue;
    currentReturnType = decl.returnType.name as YType;
    const paramTypes = decl.params.map((p) => p.paramType.name as YType);
    const scope = new FunctionScope(paramTypes);
    decl.params.forEach((p, idx) => scope.declareParam(p.name, idx, p.paramType.name as YType));

    const body = compileBlock(decl.body, scope);
    const wasmParamType = binaryen.createType(paramTypes.map(wasmType));
    const wasmReturnType = wasmType(decl.returnType.name as YType);

    mod.addFunction(decl.name, wasmParamType, wasmReturnType, scope.localTypes, body);

    if (decl.visibility === "public") {
      mod.addFunctionExport(decl.name, decl.name);
      exportedNames.push(decl.name);
    }
  }

  // ---- Memory ----
  // The string table sits at the bottom, and the heap starts right after it.
  // The maximum is left open so __yare_alloc can ask for more pages; a program
  // that concatenates strings in a loop should be allowed to have them.
  const heapStart = (heapCursor + 3) & ~3;
  const memPages = Math.max(1, Math.ceil((heapStart + PAGE_SIZE - 1) / PAGE_SIZE));
  if (stringRuntimeInstalled) {
    mod.addGlobal(HEAP_GLOBAL, binaryen.i32, true, mod.i32.const(heapStart));
  }
  mod.setMemory(
    memPages,
    -1, // no declared maximum, so __yare_alloc can keep asking for pages
    "memory",
    segments.map((s) => ({ offset: mod.i32.const(s.offset), data: s.data, passive: false })) as any
  );

  const valid = mod.validate();
  if (!valid) {
    throw new Error("Generated WebAssembly module failed validation. This is a yarescript compiler bug.");
  }

  mod.optimize();

  const wat = mod.emitText();
  const wasmBinary = mod.emitBinary();
  mod.dispose();

  return { wasmBinary, wat, usedHostFunctions: [...usedHostFunctions], stringConstants };

  // ---------------- inner compile helpers (closures over `mod`) ----------------

  function calleeQualifiedName(expr: N.Expr): string | null {
    if (expr.kind === "Identifier") return expr.name;
    if (expr.kind === "MemberExpr") {
      const base = calleeQualifiedName(expr.object);
      return base ? `${base}.${expr.property}` : null;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Casts. WebAssembly has an instruction for every one of these, so a cast
  // costs one opcode and zero apologies.
  // ------------------------------------------------------------------
  function castTo(target: YType, from: YType, value: number): number {
    if (from === target) return value;
    const src = wasmKind(from);
    const dst = wasmKind(target);
    if (dst === "i32") {
      if (src === "i32") return value;
      if (src === "i64") return mod.i32.wrap(value);
      if (src === "f32") return mod.i32.trunc_s.f32(value);
      return mod.i32.trunc_s.f64(value);
    }
    if (dst === "i64") {
      if (src === "i32") return mod.i64.extend_s(value);
      if (src === "i64") return value;
      if (src === "f32") return mod.i64.trunc_s.f32(value);
      return mod.i64.trunc_s.f64(value);
    }
    if (dst === "f32") {
      if (src === "i32") return mod.f32.convert_s.i32(value);
      if (src === "i64") return mod.f32.convert_s.i64(value);
      if (src === "f32") return value;
      return mod.f32.demote(value);
    }
    if (src === "i32") return mod.f64.convert_s.i32(value);
    if (src === "i64") return mod.f64.convert_s.i64(value);
    if (src === "f32") return mod.f64.promote(value);
    return value;
  }

  // binaryen's i64.const wants (low, high) and quietly truncates a lone
  // argument above 2^32, so the split happens here instead of by accident.
  function i64Const(value: number): number {
    const low = ((value % 4294967296) + 4294967296) % 4294967296;
    const high = Math.floor(value / 4294967296);
    return mod.i64.const(low, high);
  }

  function wasmKind(t: YType): "i32" | "i64" | "f32" | "f64" {
    if (t === "long") return "i64";
    if (t === "float") return "f32";
    if (t === "double") return "f64";
    return "i32"; // int, char, bool and string pointers all live in an i32
  }

  // ------------------------------------------------------------------
  // The string runtime.
  //
  // Strings are length-prefixed UTF-8 in linear memory, so `+` and `==` need
  // somewhere to put results. These four functions are that somewhere. They
  // get added to the module only if your program actually uses a string
  // operator, because a hello-world does not need a heap.
  // ------------------------------------------------------------------
  function ensureStringRuntime(): void {
    if (stringRuntimeInstalled) return;
    stringRuntimeInstalled = true;

    const page = mod.i32.const(PAGE_SIZE);
    const currentBytes = mod.i32.mul(mod.memory.size(), page);
    const align4 = (x: number) => mod.i32.and(mod.i32.add(x, mod.i32.const(3)), mod.i32.const(-4));

    // __yare_alloc(bytes) -> pointer to `bytes` of fresh, empty, yours-now
    // memory. Bumps a cursor, and asks WebAssembly for more pages when the
    // cursor runs off the end of the world.
    mod.addFunction(
      "__yare_alloc",
      binaryen.createType([binaryen.i32]),
      binaryen.i32,
      [binaryen.i32, binaryen.i32, binaryen.i32],
      blk([
        mod.local.set(1, mod.global.get(HEAP_GLOBAL, binaryen.i32)),
        mod.local.set(
          2,
          mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(8)))
        ),
        mod.if(
          mod.i32.gt_u(mod.local.get(2, binaryen.i32), currentBytes),
          blk([
            mod.local.set(
              3,
              mod.i32.div_u(
                mod.i32.add(
                  mod.i32.sub(mod.local.get(2, binaryen.i32), mod.i32.mul(mod.memory.size(), page)),
                  mod.i32.const(PAGE_SIZE - 1)
                ),
                page
              )
            ),
            // memory.grow hands back the old page count, or -1 when the host
            // says no. A -1 here means out of memory, so we stop the program
            // rather than scribble on somebody else's bytes.
            mod.if(mod.i32.lt_s(mod.memory.grow(mod.local.get(3, binaryen.i32)), mod.i32.const(0)), mod.unreachable()),
          ])
        ),
        mod.global.set(
          HEAP_GLOBAL,
          align4(mod.i32.add(mod.local.get(1, binaryen.i32), mod.local.get(0, binaryen.i32)))
        ),
        mod.return(mod.local.get(1, binaryen.i32)),
      ])
    );

    // __yare_str_alloc(len) -> pointer to a string header plus `len` bytes.
    mod.addFunction(
      "__yare_str_alloc",
      binaryen.createType([binaryen.i32]),
      binaryen.i32,
      [binaryen.i32],
      blk([
        mod.local.set(1, mod.call("__yare_alloc", [mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(4))], binaryen.i32)),
        mod.i32.store(0, 4, mod.local.get(1, binaryen.i32), mod.local.get(0, binaryen.i32)),
        mod.return(mod.local.get(1, binaryen.i32)),
      ])
    );

    // __yare_str_concat(a, b) -> a brand new string. Neither input is harmed.
    mod.addFunction(
      "__yare_str_concat",
      binaryen.createType([binaryen.i32, binaryen.i32]),
      binaryen.i32,
      [binaryen.i32, binaryen.i32, binaryen.i32],
      blk([
        mod.local.set(2, mod.i32.load(0, 4, mod.local.get(0, binaryen.i32))),
        mod.local.set(3, mod.i32.load(0, 4, mod.local.get(1, binaryen.i32))),
        mod.local.set(
          4,
          mod.call("__yare_str_alloc", [mod.i32.add(mod.local.get(2, binaryen.i32), mod.local.get(3, binaryen.i32))], binaryen.i32)
        ),
        mod.memory.copy(
          mod.i32.add(mod.local.get(4, binaryen.i32), mod.i32.const(4)),
          mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(4)),
          mod.local.get(2, binaryen.i32)
        ),
        mod.memory.copy(
          mod.i32.add(mod.i32.add(mod.local.get(4, binaryen.i32), mod.i32.const(4)), mod.local.get(2, binaryen.i32)),
          mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.const(4)),
          mod.local.get(3, binaryen.i32)
        ),
        mod.return(mod.local.get(4, binaryen.i32)),
      ])
    );

    // __yare_str_eq(a, b) -> 1 when the two strings hold the same bytes.
    // Byte by byte, because two pointers being equal is not the same thing as
    // two strings being equal, and that mistake is a classic.
    const done = "yare_eq_done";
    const loop = "yare_eq_loop";
    mod.addFunction(
      "__yare_str_eq",
      binaryen.createType([binaryen.i32, binaryen.i32]),
      binaryen.i32,
      [binaryen.i32, binaryen.i32, binaryen.i32],
      blk([
        mod.block(done, [
          mod.if(mod.i32.eq(mod.local.get(0, binaryen.i32), mod.local.get(1, binaryen.i32)), mod.return(mod.i32.const(1))),
          mod.local.set(2, mod.i32.load(0, 4, mod.local.get(0, binaryen.i32))),
          mod.local.set(3, mod.i32.load(0, 4, mod.local.get(1, binaryen.i32))),
          mod.if(mod.i32.ne(mod.local.get(2, binaryen.i32), mod.local.get(3, binaryen.i32)), mod.return(mod.i32.const(0))),
          mod.local.set(4, mod.i32.const(0)),
          mod.loop(
            loop,
            blk([
              mod.br(done, mod.i32.ge_u(mod.local.get(4, binaryen.i32), mod.local.get(2, binaryen.i32))),
              mod.if(
                mod.i32.ne(
                  mod.i32.load8_u(0, 1, mod.i32.add(mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(4)), mod.local.get(4, binaryen.i32))),
                  mod.i32.load8_u(0, 1, mod.i32.add(mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.const(4)), mod.local.get(4, binaryen.i32)))
                ),
                mod.return(mod.i32.const(0))
              ),
              mod.local.set(4, mod.i32.add(mod.local.get(4, binaryen.i32), mod.i32.const(1))),
              mod.br(loop),
            ])
          ),
        ]),
        mod.return(mod.i32.const(1)),
      ])
    );
  }

  function compileBlock(block: N.Block, scope: FunctionScope): number {
    const child = scope.child();
    const stmts = block.body.map((s) => compileStmt(s, child));
    return (mod.block as any)(null, stmts, binaryen.auto);
  }

  function compileStmt(stmt: N.Stmt, scope: FunctionScope): number {
    switch (stmt.kind) {
      case "VarDecl": {
        const type = stmt.varType.name as YType;
        const index = scope.declareLocal(stmt.name, type);
        if (stmt.init) {
          // `let: long y = 2;` is legal yarescript, and an i32.const sitting in
          // an i64 local is not legal WebAssembly. The checker said yes, so
          // codegen has to do the actual widening.
          const initType = (stmt.init as any).inferredType as YType;
          return mod.local.set(index, castTo(type, initType, compileExpr(stmt.init, scope)));
        }
        return mod.nop();
      }
      case "Block":
        return compileBlock(stmt, scope);
      case "ExprStmt": {
        const value = compileExpr(stmt.expression, scope);
        const exprType = (stmt.expression as any).inferredType as YType | undefined;
        if (!exprType || exprType === "void") return mod.drop === undefined ? value : dropIfNeeded(value, exprType);
        return dropIfNeeded(value, exprType);
      }
      case "ReturnStmt": {
        if (!stmt.argument) return mod.return(undefined);
        const t = (stmt.argument as any).inferredType as YType;
        return mod.return(castTo(currentReturnType, t, compileExpr(stmt.argument, scope)));
      }
      case "IfStmt": {
        const test = compileExpr(stmt.test, scope);
        const cons = compileBlock(stmt.consequent, scope);
        const alt = stmt.alternate
          ? stmt.alternate.kind === "IfStmt"
            ? compileStmt(stmt.alternate, scope)
            : compileBlock(stmt.alternate, scope)
          : undefined;
        return mod.if(test, cons, alt);
      }
      case "WhileStmt": {
        const id = labelId++;
        const breakLabel = `while_${id}_end`;
        const continueLabel = `while_${id}_continue`;
        const test = compileExpr(stmt.test, scope);
        loopStack.push({ breakLabel, continueLabel });
        const body = compileBlock(stmt.body, scope);
        loopStack.pop();
        const loopBody = (mod.block as any)(null, [
          mod.if(mod.i32.eqz(test), mod.br(breakLabel)),
          body,
          mod.br(continueLabel),
        ]);
        return mod.block(breakLabel, [mod.loop(continueLabel, loopBody)]);
      }
      case "ForStmt": {
        const forScope = scope.child();
        const id = labelId++;
        const breakLabel = `for_${id}_end`;
        // `continue` must still run the update expression before the next
        // test, so its target is an inner block that *wraps only the body*;
        // falling out of that block flows straight into `update`.
        const continueLabel = `for_${id}_continue`;
        const loopLabel = `for_${id}_loop`;
        const initStmt = stmt.init ? compileStmt(stmt.init, forScope) : mod.nop();
        const test = stmt.test ? compileExpr(stmt.test, forScope) : mod.i32.const(1);
        loopStack.push({ breakLabel, continueLabel });
        const body = compileBlock(stmt.body, forScope);
        loopStack.pop();
        const update = stmt.update
          ? dropIfNeeded(compileExpr(stmt.update, forScope), (stmt.update as any).inferredType)
          : mod.nop();
        const loopBody = (mod.block as any)(null, [
          mod.if(mod.i32.eqz(test), mod.br(breakLabel)),
          mod.block(continueLabel, [body]),
          update,
          mod.br(loopLabel),
        ]);
        return mod.block(breakLabel, [initStmt, mod.loop(loopLabel, loopBody)]);
      }
      case "BreakStmt": {
        const ctx = loopStack[loopStack.length - 1];
        if (!ctx) throw new Error("codegen: 'break' used outside of a loop");
        return mod.br(ctx.breakLabel);
      }
      case "ContinueStmt": {
        const ctx = loopStack[loopStack.length - 1];
        if (!ctx) throw new Error("codegen: 'continue' used outside of a loop");
        return mod.br(ctx.continueLabel);
      }
    }
  }

  function dropIfNeeded(expr: number, type: YType | undefined): number {
    if (!type || type === "void") return expr;
    return mod.drop(expr);
  }

  function compileExpr(expr: N.Expr, scope: FunctionScope): number {
    switch (expr.kind) {
      case "IntLiteral":
        return expr.inferredType === "long" ? i64Const(expr.value) : mod.i32.const(expr.value);
      case "FloatLiteral":
        return mod.f64.const(expr.value);
      case "BoolLiteral":
        return mod.i32.const(expr.value ? 1 : 0);
      case "StringLiteral":
        return mod.i32.const(internString(expr.value));
      case "Identifier": {
        const info = scope.lookup(expr.name);
        return mod.local.get(info.index, wasmType(info.type));
      }
      case "CastExpr": {
        const from = (expr.expr as any).inferredType as YType;
        const target = expr.targetType.name as YType;
        return castTo(target, from, compileExpr(expr.expr, scope));
      }
      case "MemberExpr":
        throw new Error("codegen: bare member expressions are not values (checker should have caught this)");
      case "UnaryExpr": {
        const t = (expr.argument as any).inferredType as YType;
        if (expr.operator === "!") {
          return mod.i32.eqz(compileExpr(expr.argument, scope));
        }
        if (expr.operator === "-") {
          const val = compileExpr(expr.argument, scope);
          return arith(t, "sub", zero(t), val);
        }
        if (expr.operator === "++" || expr.operator === "--") {
          if (expr.argument.kind !== "Identifier") {
            throw new Error("codegen: ++/-- only supported on simple variables");
          }
          const info = scope.lookup(expr.argument.name);
          const one = one_(t);
          const newVal = arith(t, expr.operator === "++" ? "add" : "sub", mod.local.get(info.index, wasmType(t)), one);
          const setOp = mod.local.set(info.index, newVal);
          if (expr.prefix) {
            return (mod.block as any)(null, [setOp, mod.local.get(info.index, wasmType(t))], wasmType(t));
          }
          // postfix: stash the old value in a hidden temp local, apply the
          // update, then yield the stashed value.
          const tempIndex = scope.declareLocal(`__tmp_postfix_${labelId++}`, t);
          return (mod.block as any)(
            null,
            [
              mod.local.set(tempIndex, mod.local.get(info.index, wasmType(t))),
              setOp,
              mod.local.get(tempIndex, wasmType(t)),
            ],
            wasmType(t)
          );
        }
        throw new Error(`codegen: unsupported unary operator '${expr.operator}'`);
      }
      case "BinaryExpr": {
        const lt = (expr.left as any).inferredType as YType;
        const rt = (expr.right as any).inferredType as YType;
        const l = compileExpr(expr.left, scope);
        const r = compileExpr(expr.right, scope);
        return compileBinary(expr.operator, lt, rt, l, r);
      }
      case "AssignExpr": {
        if (expr.target.kind !== "Identifier") {
          throw new Error("codegen: complex assignment targets not yet supported");
        }
        const info = scope.lookup(expr.target.name);
        let value = compileExpr(expr.value, scope);
        if (expr.operator !== "=") {
          const op = expr.operator.replace("=", "");
          const current = mod.local.get(info.index, wasmType(info.type));
          value = compileBinary(op, info.type, (expr.value as any).inferredType, current, value);
        }
        const valueType = (expr.value as any).inferredType as YType;
        const setInstr = mod.local.set(info.index, castTo(info.type, valueType, value));
        return (mod.block as any)(null, [setInstr, mod.local.get(info.index, wasmType(info.type))], wasmType(info.type));
      }
      case "CallExpr": {
        const calleeName = calleeQualifiedName(expr.callee)!;
        if (expr.resolvedKind === "host") {
          const sig = HOST_FUNCTIONS[calleeName];
          const argType = (expr.args[0] as any).inferredType as YType;
          const hostName = sig.overloads[argType]!;
          const args = [compileExpr(expr.args[0], scope)];
          return mod.call(hostName, args, wasmType(sig.returnType));
        }
        // user function
        const args = expr.args.map((a) => compileExpr(a, scope));
        return mod.call(calleeName, args, wasmType(expr.inferredType as YType));
      }
    }
  }

  function zero(t: YType): number {
    if (t === "long") return mod.i64.const(0, 0);
    if (t === "float") return mod.f32.const(0);
    if (t === "double") return mod.f64.const(0);
    return mod.i32.const(0);
  }

  function one_(t: YType): number {
    if (t === "long") return mod.i64.const(1, 0);
    if (t === "float") return mod.f32.const(1);
    if (t === "double") return mod.f64.const(1);
    return mod.i32.const(1);
  }

  function compileBinary(operator: string, lt: YType, rt: YType, l: number, r: number): number {
    // String operators go through the runtime helpers, because two pointers
    // and a length prefix are not something you want to open-code at every
    // call site.
    if (lt === "string" || rt === "string") {
      ensureStringRuntime();
      switch (operator) {
        case "+":
          return mod.call("__yare_str_concat", [l, r], binaryen.i32);
        case "==":
          return mod.call("__yare_str_eq", [l, r], binaryen.i32);
        case "!=":
          return mod.i32.eqz(mod.call("__yare_str_eq", [l, r], binaryen.i32));
        default:
          throw new Error(`codegen: '${operator}' is not defined for string`);
      }
    }
    // The checker picked the result type by widening; codegen has to actually
    // perform that widening on the operands, or we hand WebAssembly an
    // f64.add with an i32 in it and it (rightly) refuses to build.
    const bothNumeric = isNumeric(lt) && isNumeric(rt);
    const t = bothNumeric ? widen(lt, rt) : lt;
    const lv = bothNumeric ? castTo(t, lt, l) : l;
    const rv = bothNumeric ? castTo(t, rt, r) : r;
    const bin = binOps(t);
    switch (operator) {
      case "+":
        return bin.add(lv, rv);
      case "-":
        return bin.sub(lv, rv);
      case "*":
        return bin.mul(lv, rv);
      case "/":
        return bin.div(lv, rv);
      case "%":
        return bin.rem(lv, rv);
      case "==":
        return bin.eq(lv, rv);
      case "!=":
        return bin.ne(lv, rv);
      case "<":
        return bin.lt(lv, rv);
      case ">":
        return bin.gt(lv, rv);
      case "<=":
        return bin.le(lv, rv);
      case ">=":
        return bin.ge(lv, rv);
      case "&&":
        return mod.i32.and(lv, rv);
      case "||":
        return mod.i32.or(lv, rv);
      default:
        throw new Error(`codegen: unsupported binary operator '${operator}'`);
    }
  }

  function arith(t: YType, op: "add" | "sub", a: number, b: number): number {
    return binOps(t)[op](a, b);
  }

  function binOps(t: YType) {
    if (t === "int" || t === "bool" || t === "char") {
      return {
        add: mod.i32.add,
        sub: mod.i32.sub,
        mul: mod.i32.mul,
        div: mod.i32.div_s,
        rem: mod.i32.rem_s,
        eq: mod.i32.eq,
        ne: mod.i32.ne,
        lt: mod.i32.lt_s,
        gt: mod.i32.gt_s,
        le: mod.i32.le_s,
        ge: mod.i32.ge_s,
      };
    }
    if (t === "long") {
      return {
        add: mod.i64.add,
        sub: mod.i64.sub,
        mul: mod.i64.mul,
        div: mod.i64.div_s,
        rem: mod.i64.rem_s,
        eq: mod.i64.eq,
        ne: mod.i64.ne,
        lt: mod.i64.lt_s,
        gt: mod.i64.gt_s,
        le: mod.i64.le_s,
        ge: mod.i64.ge_s,
      };
    }
    if (t === "float") {
      return {
        add: mod.f32.add,
        sub: mod.f32.sub,
        mul: mod.f32.mul,
        div: mod.f32.div,
        rem: () => {
          throw new Error("codegen: '%' is not defined for float");
        },
        eq: mod.f32.eq,
        ne: mod.f32.ne,
        lt: mod.f32.lt,
        gt: mod.f32.gt,
        le: mod.f32.le,
        ge: mod.f32.ge,
      } as any;
    }
    // double
    return {
      add: mod.f64.add,
      sub: mod.f64.sub,
      mul: mod.f64.mul,
      div: mod.f64.div,
      rem: () => {
        throw new Error("codegen: '%' is not defined for double");
      },
      eq: mod.f64.eq,
      ne: mod.f64.ne,
      lt: mod.f64.lt,
      gt: mod.f64.gt,
      le: mod.f64.le,
      ge: mod.f64.ge,
    } as any;
  }
}

let labelId = 0;

function walk(node: N.Node, visit: (n: N.Node) => void): void {
  visit(node);
  switch (node.kind) {
    case "Program":
      node.body.forEach((n) => walk(n, visit));
      break;
    case "FunctionDecl":
      walk(node.body, visit);
      break;
    case "VarDecl":
      if (node.init) walk(node.init, visit);
      break;
    case "Block":
      node.body.forEach((n) => walk(n, visit));
      break;
    case "IfStmt":
      walk(node.test, visit);
      walk(node.consequent, visit);
      if (node.alternate) walk(node.alternate, visit);
      break;
    case "WhileStmt":
      walk(node.test, visit);
      walk(node.body, visit);
      break;
    case "ForStmt":
      if (node.init) walk(node.init, visit);
      if (node.test) walk(node.test, visit);
      if (node.update) walk(node.update, visit);
      walk(node.body, visit);
      break;
    case "ReturnStmt":
      if (node.argument) walk(node.argument, visit);
      break;
    case "ExprStmt":
      walk(node.expression, visit);
      break;
    case "BinaryExpr":
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case "UnaryExpr":
      walk(node.argument, visit);
      break;
    case "AssignExpr":
      walk(node.target, visit);
      walk(node.value, visit);
      break;
    case "CallExpr":
      walk(node.callee, visit);
      node.args.forEach((a) => walk(a, visit));
      break;
    case "CastExpr":
      walk(node.expr, visit);
      break;
    case "MemberExpr":
      walk(node.object, visit);
      break;
    default:
      break;
  }
}
