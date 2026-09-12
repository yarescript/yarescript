import binaryen = require("binaryen");
import * as N from "../ast/nodes";
import { CheckedProgram, HOST_FUNCTIONS } from "../checker/checker";
import {
  alignOfType,
  arrayOf,
  elemTypeOf,
  isArrayType,
  isNumeric,
  isSigned,
  sizeOfType,
  widen,
  YType,
} from "../checker/types";
import { StructInfo } from "../checker/checker";

/**
 * Lowers a type-checked yarescript AST straight to a WebAssembly module
 * using binaryen. This is the whole point of the language: no JS emitted
 * here, ever. The only JS yarescript produces is the tiny host-side loader
 * (see src/runtime/loader-template.ts) that instantiates this module and hands it
 * a handful of host functions (console.println, etc).
 *
 * If you ever find this file emitting JavaScript, stop reading and file a bug:
 * that is the one promise the language makes, and it does not get to be
 * approximate.
 */

const PAGE_SIZE = 65536;

function wasmType(t: YType): number {
  switch (t) {
    // the narrow integers all ride in an i32; the masks below keep them honest
    case "i8":
    case "i16":
    case "u8":
    case "u16":
    case "u32":
    case "int":
    case "bool":
      return binaryen.i32;
    case "long":
    case "u64":
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
    default:
      // arrays and structs are both "a pointer to a block of memory", which is
      // an i32 like every other pointer in here
      return binaryen.i32;
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
  let heapInstalled = false;
  let strCmpInstalled = false;

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

  // ---- Host imports (console.println overloads etc.) ----
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
    currentReturnType = N.typeSpelling(decl.returnType);
    const paramTypes = decl.params.map((p) => N.typeSpelling(p.paramType));
    const scope = new FunctionScope(paramTypes);
    decl.params.forEach((p, idx) => scope.declareParam(p.name, idx, N.typeSpelling(p.paramType)));

    const body = compileBlock(decl.body, scope);
    const wasmParamType = binaryen.createType(paramTypes.map(wasmType));
    const wasmReturnType = wasmType(N.typeSpelling(decl.returnType));

    // A function that returns a value has to end on an instruction that can
    // produce one. When every path already returned, all that is left at the
    // end is a loop or a block with nothing to give, and WebAssembly insists
    // the types line up anyway. `unreachable` is the honest way to say "you
    // cannot get here", and the optimizer throws it away.
    const finalBody =
      wasmReturnType === binaryen.none ? body : blk([body, mod.unreachable()], wasmReturnType);

    mod.addFunction(decl.name, wasmParamType, wasmReturnType, scope.localTypes, finalBody);

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
  if (heapInstalled) {
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
  /**
   * Every value lands in a type that may be narrower than the wasm register
   * holding it, so the last step of any cast is putting it back in range.
   * Without this an i8 quietly carries 200 around until the first comparison.
   */
  function normalize(t: YType, value: number): number {
    switch (t) {
      case "i8":
        return mod.i32.extend8_s(value);
      case "i16":
        return mod.i32.extend16_s(value);
      case "u8":
        return mod.i32.and(value, mod.i32.const(0xff));
      case "u16":
        return mod.i32.and(value, mod.i32.const(0xffff));
      default:
        return value;
    }
  }

  function castTo(target: YType, from: YType, value: number): number {
    const converted = from === target ? value : convertKind(from, target, value);
    return normalize(target, converted);
  }

  function convertKind(from: YType, to: YType, value: number): number {
    const src = wasmKind(from);
    const dst = wasmKind(to);
    // unsigned sources convert differently on the way out, and WebAssembly
    // is fussy about which flavour you picked
    const signed = isSigned(from);
    if (src === dst) return value;
    if (dst === "i32") {
      if (src === "i32") return value;
      if (src === "i64") return mod.i32.wrap(value);
      if (src === "f32") return mod.i32.trunc_s.f32(value);
      return mod.i32.trunc_s.f64(value);
    }
    if (dst === "i64") {
      if (src === "i32") return signed ? mod.i64.extend_s(value) : mod.i64.extend_u(value);
      if (src === "i64") return value;
      if (src === "f32") return signed ? mod.i64.trunc_s.f32(value) : mod.i64.trunc_u.f32(value);
      return signed ? mod.i64.trunc_s.f64(value) : mod.i64.trunc_u.f64(value);
    }
    if (dst === "f32") {
      if (src === "i32") return signed ? mod.f32.convert_s.i32(value) : mod.f32.convert_u.i32(value);
      if (src === "i64") return signed ? mod.f32.convert_s.i64(value) : mod.f32.convert_u.i64(value);
      if (src === "f32") return value;
      return mod.f32.demote(value);
    }
    if (src === "i32") return signed ? mod.f64.convert_s.i32(value) : mod.f64.convert_u.i32(value);
    if (src === "i64") return signed ? mod.f64.convert_s.i64(value) : mod.f64.convert_u.i64(value);
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

  // ------------------------------------------------------------------
  // Reading and writing one value at a byte offset. Arrays and structs are
  // both "a pointer plus some offsets", so this is the only place in the
  // compiler that knows an i8 is one byte wide and a double is eight.
  //
  // The alignment hint is capped at 4: every block the allocator hands back
  // is 4-aligned, and a hint bigger than the address would be a lie that
  // WebAssembly is entitled to act on.
  // ------------------------------------------------------------------
  function alignHint(t: YType): number {
    return Math.min(sizeOfType(t), 4);
  }

  function loadAt(t: YType, addr: number): number {
    switch (t) {
      case "i8":
        return mod.i32.load8_s(0, 1, addr);
      case "u8":
        return mod.i32.load8_u(0, 1, addr);
      case "i16":
        return mod.i32.load16_s(0, 2, addr);
      case "u16":
      case "char":
        return mod.i32.load16_u(0, 2, addr);
      case "long":
      case "u64":
        return mod.i64.load(0, alignHint(t), addr);
      case "float":
        return mod.f32.load(0, 4, addr);
      case "double":
        return mod.f64.load(0, alignHint(t), addr);
      default:
        return mod.i32.load(0, 4, addr);
    }
  }

  function storeAt(t: YType, addr: number, value: number): number {
    switch (t) {
      case "i8":
      case "u8":
        return mod.i32.store8(0, 1, addr, value);
      case "i16":
      case "u16":
      case "char":
        return mod.i32.store16(0, 2, addr, value);
      case "long":
      case "u64":
        return mod.i64.store(0, alignHint(t), addr, value);
      case "float":
        return mod.f32.store(0, 4, addr, value);
      case "double":
        return mod.f64.store(0, alignHint(t), addr, value);
      default:
        return mod.i32.store(0, 4, addr, value);
    }
  }

  /**
   * Arrays keep their element count in a u32 header, exactly like strings.
   * Eight byte elements get an eight byte header so the first one stays
   * aligned, which is the whole reason this is a function.
   */
  function arrayHeader(elem: YType): number {
    return sizeOfType(elem) === 8 ? 8 : 4;
  }

  /** A place you can write to: an array slot or a struct field. */
  interface Lvalue {
    /** instructions that compute the address, in order */
    setup: number[];
    /** local holding the byte address once `setup` has run */
    addrLocal: number;
    type: YType;
  }

  /**
   * Works out where an array slot or struct field lives, and puts the address
   * in a local. The address is computed once, on purpose: `xs[i++] = 1` is
   * allowed to increment `i` exactly one time.
   */
  function compileLvalue(target: N.IndexExpr | N.MemberExpr, scope: FunctionScope): Lvalue {
    const objType = (target.object as any).inferredType as YType;
    const ptrLocal = scope.declareLocal(`__yare_lv_ptr_${labelId++}`, "int");
    const addrLocal = scope.declareLocal(`__yare_lv_at_${labelId++}`, "int");
    const ptr = () => mod.local.get(ptrLocal, binaryen.i32);

    if (target.kind === "IndexExpr") {
      const elem = elemTypeOf(objType);
      const size = sizeOfType(elem);
      const header = arrayHeader(elem);
      const idxLocal = scope.declareLocal(`__yare_lv_idx_${labelId++}`, "int");
      const idx = () => mod.local.get(idxLocal, binaryen.i32);
      const idxType = (target.index as any).inferredType as YType;
      return {
        setup: [
          mod.local.set(ptrLocal, compileExpr(target.object, scope)),
          mod.local.set(idxLocal, castTo("int", idxType, compileExpr(target.index, scope))),
          // out of range is a trap, not a shrug: reading past the end of an
          // array is how programs find out what their neighbours were storing
          mod.if(
            mod.i32.or(
              mod.i32.lt_s(idx(), mod.i32.const(0)),
              mod.i32.ge_s(idx(), mod.i32.load(0, 4, ptr()))
            ),
            mod.unreachable()
          ),
          mod.local.set(
            addrLocal,
            mod.i32.add(
              mod.i32.add(ptr(), mod.i32.const(header)),
              mod.i32.mul(idx(), mod.i32.const(size))
            )
          ),
        ],
        addrLocal,
        type: elem,
      };
    }

    const struct = checked.structs.get(objType);
    if (!struct) {
      throw new Error(`codegen: '${objType}' has no fields to reach into (checker should have caught this)`);
    }
    const field = struct.fields.find((f) => f.name === target.property)!;
    return {
      setup: [
        mod.local.set(ptrLocal, compileExpr(target.object, scope)),
        mod.local.set(addrLocal, mod.i32.add(ptr(), mod.i32.const(field.offset))),
      ],
      addrLocal,
      type: field.type,
    };
  }

  function wasmKind(t: YType): "i32" | "i64" | "f32" | "f64" {
    if (t === "long" || t === "u64") return "i64";
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
  /**
   * The bump allocator. Strings, arrays, and structs all live on it, so it is
   * installed the first time any of them shows up in your program.
   */
  function ensureHeap(): void {
    if (heapInstalled) return;
    heapInstalled = true;

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
  }

  function ensureStringRuntime(): void {
    if (stringRuntimeInstalled) return;
    stringRuntimeInstalled = true;
    ensureHeap();

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

    // __yare_str_push_char(s, c) -> s with one more byte on the end.
    mod.addFunction(
      "__yare_str_push_char",
      binaryen.createType([binaryen.i32, binaryen.i32]),
      binaryen.i32,
      [binaryen.i32, binaryen.i32],
      blk([
        mod.local.set(2, mod.i32.load(0, 4, mod.local.get(0, binaryen.i32))),
        mod.local.set(3, mod.call("__yare_str_alloc", [mod.i32.add(mod.local.get(2, binaryen.i32), mod.i32.const(1))], binaryen.i32)),
        mod.memory.copy(
          mod.i32.add(mod.local.get(3, binaryen.i32), mod.i32.const(4)),
          mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(4)),
          mod.local.get(2, binaryen.i32)
        ),
        mod.i32.store8(
          0,
          1,
          mod.i32.add(mod.i32.add(mod.local.get(3, binaryen.i32), mod.i32.const(4)), mod.local.get(2, binaryen.i32)),
          mod.local.get(1, binaryen.i32)
        ),
        mod.return(mod.local.get(3, binaryen.i32)),
      ])
    );

    // __yare_char_push_str(c, s) -> one byte, then s. Same idea, other end.
    mod.addFunction(
      "__yare_char_push_str",
      binaryen.createType([binaryen.i32, binaryen.i32]),
      binaryen.i32,
      [binaryen.i32, binaryen.i32],
      blk([
        mod.local.set(2, mod.i32.load(0, 4, mod.local.get(1, binaryen.i32))),
        mod.local.set(3, mod.call("__yare_str_alloc", [mod.i32.add(mod.local.get(2, binaryen.i32), mod.i32.const(1))], binaryen.i32)),
        mod.i32.store8(0, 1, mod.i32.add(mod.local.get(3, binaryen.i32), mod.i32.const(4)), mod.local.get(0, binaryen.i32)),
        mod.memory.copy(
          mod.i32.add(mod.i32.add(mod.local.get(3, binaryen.i32), mod.i32.const(4)), mod.i32.const(1)),
          mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.const(4)),
          mod.local.get(2, binaryen.i32)
        ),
        mod.return(mod.local.get(3, binaryen.i32)),
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

  /**
   * Ordering for strings. Byte order, which for UTF-8 is also code point
   * order: predictable, locale-free, and not pretending to be a collation.
   */
  function strCompare(operator: string, l: number, r: number): number {
    if (!strCmpInstalled) {
      strCmpInstalled = true;
      addStrCmp();
    }
    const cmp = mod.call("__yare_str_cmp", [l, r], binaryen.i32);
    // a fresh zero per branch: a wasm node is allowed exactly one parent
    switch (operator) {
      case "<":
        return mod.i32.lt_s(cmp, mod.i32.const(0));
      case ">":
        return mod.i32.gt_s(cmp, mod.i32.const(0));
      case "<=":
        return mod.i32.le_s(cmp, mod.i32.const(0));
      default:
        return mod.i32.ge_s(cmp, mod.i32.const(0));
    }
  }

  /**
   * __yare_str_cmp(a, b) -> negative when a sorts first, 0 when they hold the
   * same bytes, positive when b sorts first. Byte by byte, then by length, so
   * "apple" < "apples" for the boring and correct reason.
   */
  function addStrCmp(): void {
    const done = "yare_cmp_done";
    const loop = "yare_cmp_loop";
    mod.addFunction(
      "__yare_str_cmp",
      binaryen.createType([binaryen.i32, binaryen.i32]),
      binaryen.i32,
      [binaryen.i32, binaryen.i32, binaryen.i32, binaryen.i32, binaryen.i32],
      blk([
        mod.block(done, [
          mod.local.set(2, mod.i32.load(0, 4, mod.local.get(0, binaryen.i32))),
          mod.local.set(3, mod.i32.load(0, 4, mod.local.get(1, binaryen.i32))),
          mod.local.set(4, mod.i32.const(0)),
          mod.loop(
            loop,
            blk([
              mod.br(
                done,
                mod.i32.or(
                  mod.i32.ge_u(mod.local.get(4, binaryen.i32), mod.local.get(2, binaryen.i32)),
                  mod.i32.ge_u(mod.local.get(4, binaryen.i32), mod.local.get(3, binaryen.i32))
                )
              ),
              mod.if(
                mod.i32.ne(
                  mod.i32.load8_u(0, 1, mod.i32.add(mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(4)), mod.local.get(4, binaryen.i32))),
                  mod.i32.load8_u(0, 1, mod.i32.add(mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.const(4)), mod.local.get(4, binaryen.i32)))
                ),
                mod.return(
                  mod.i32.sub(
                    mod.i32.load8_u(0, 1, mod.i32.add(mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(4)), mod.local.get(4, binaryen.i32))),
                    mod.i32.load8_u(0, 1, mod.i32.add(mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.const(4)), mod.local.get(4, binaryen.i32)))
                  )
                )
              ),
              mod.local.set(4, mod.i32.add(mod.local.get(4, binaryen.i32), mod.i32.const(1))),
              mod.br(loop),
            ])
          ),
        ]),
        mod.return(mod.i32.sub(mod.local.get(2, binaryen.i32), mod.local.get(3, binaryen.i32))),
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
        const type = N.typeSpelling(stmt.varType);
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
      case "IntLiteral": {
        if (expr.inferredType === "long" || expr.inferredType === "u64") return i64Const(expr.value);
        // a u32 above 2^31 has to be handed over with the same bits, and
        // binaryen's i32.const reads a signed number
        return mod.i32.const(expr.inferredType === "u32" ? expr.value | 0 : expr.value);
      }
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
      case "IndexExpr": {
        const objType = (expr.object as any).inferredType as YType;
        if (objType !== "string") {
          const lv = compileLvalue(expr, scope);
          const get = mod.local.get(lv.addrLocal, binaryen.i32);
          return blk([...lv.setup, loadAt(lv.type, get)], wasmType(lv.type));
        }
        // Bounds checked, because reading past the end of a string is how
        // programs find out what their neighbours were storing.
        const idxType = (expr.index as any).inferredType as YType;
        const ptrLocal = scope.declareLocal(`__yare_idx_ptr_${labelId++}`, "int");
        const idxLocal = scope.declareLocal(`__yare_idx_at_${labelId++}`, "int");
        const len = mod.i32.load(0, 4, mod.local.get(ptrLocal, binaryen.i32));
        const at = mod.i32.load8_u(
          0,
          1,
          mod.i32.add(
            mod.i32.add(mod.local.get(ptrLocal, binaryen.i32), mod.i32.const(4)),
            mod.local.get(idxLocal, binaryen.i32)
          )
        );
        return blk(
          [
            mod.local.set(ptrLocal, compileExpr(expr.object, scope)),
            mod.local.set(idxLocal, castTo("int", idxType, compileExpr(expr.index, scope))),
            mod.if(
              mod.i32.or(
                mod.i32.lt_s(mod.local.get(idxLocal, binaryen.i32), mod.i32.const(0)),
                mod.i32.ge_s(mod.local.get(idxLocal, binaryen.i32), len)
              ),
              mod.unreachable()
            ),
            at,
          ],
          binaryen.i32
        );
      }
      case "ArrayLiteral": {
        ensureHeap();
        const arrType = expr.inferredType as YType;
        const elem = elemTypeOf(arrType);
        const size = sizeOfType(elem);
        const header = arrayHeader(elem);
        const ptrLocal = scope.declareLocal(`__yare_arr_${labelId++}`, "int");
        const ptr = () => mod.local.get(ptrLocal, binaryen.i32);
        const steps: number[] = [
          mod.local.set(
            ptrLocal,
            mod.call("__yare_alloc", [mod.i32.const(header + expr.elements.length * size)], binaryen.i32)
          ),
          mod.i32.store(0, 4, ptr(), mod.i32.const(expr.elements.length)),
        ];
        expr.elements.forEach((element, idx) => {
          const elemType = (element as any).inferredType as YType;
          const value = normalize(elem, castTo(elem, elemType, compileExpr(element, scope)));
          steps.push(
            storeAt(elem, mod.i32.add(ptr(), mod.i32.const(header + idx * size)), value)
          );
        });
        steps.push(ptr());
        return blk(steps, binaryen.i32);
      }
      case "NewArrayExpr": {
        ensureHeap();
        const elem = elemTypeOf(expr.inferredType as YType);
        const size = sizeOfType(elem);
        const header = arrayHeader(elem);
        const countLocal = scope.declareLocal(`__yare_len_${labelId++}`, "int");
        const bytesLocal = scope.declareLocal(`__yare_bytes_${labelId++}`, "int");
        const ptrLocal = scope.declareLocal(`__yare_arr_${labelId++}`, "int");
        const sizeType = (expr.size as any).inferredType as YType;
        const count = () => mod.local.get(countLocal, binaryen.i32);
        return blk(
          [
            mod.local.set(countLocal, castTo("int", sizeType, compileExpr(expr.size, scope))),
            // a negative size would allocate half the address space, so it
            // stops here instead
            mod.if(mod.i32.lt_s(count(), mod.i32.const(0)), mod.unreachable()),
            mod.local.set(bytesLocal, mod.i32.mul(count(), mod.i32.const(size))),
            mod.local.set(
              ptrLocal,
              mod.call(
                "__yare_alloc",
                [mod.i32.add(mod.i32.const(header), mod.local.get(bytesLocal, binaryen.i32))],
                binaryen.i32
              )
            ),
            mod.i32.store(0, 4, mod.local.get(ptrLocal, binaryen.i32), count()),
            // zero filled, because "whatever was there before" is not a value
            mod.memory.fill(
              mod.i32.add(mod.local.get(ptrLocal, binaryen.i32), mod.i32.const(header)),
              mod.i32.const(0),
              mod.local.get(bytesLocal, binaryen.i32)
            ),
            mod.local.get(ptrLocal, binaryen.i32),
          ],
          binaryen.i32
        );
      }
      case "MemberExpr": {
        const objType = (expr.object as any).inferredType as YType;
        if ((objType === "string" || isArrayType(objType)) && expr.property === "length") {
          // The length is the u32 sitting in front of the bytes, for strings
          // and arrays alike, which is why they share a header shape.
          return mod.i32.load(0, 4, compileExpr(expr.object, scope));
        }
        if (checked.structs.has(objType)) {
          const lv = compileLvalue(expr, scope);
          const get = mod.local.get(lv.addrLocal, binaryen.i32);
          return blk([...lv.setup, loadAt(lv.type, get)], wasmType(lv.type));
        }
        throw new Error("codegen: bare member expressions are not values (checker should have caught this)");
      }
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
          if (expr.argument.kind === "IndexExpr" || expr.argument.kind === "MemberExpr") {
            // `xs[i]++` and `p.x++`: read the slot, nudge it, put it back.
            const lv = compileLvalue(expr.argument, scope);
            const wt = wasmType(lv.type);
            const oldLocal = scope.declareLocal(`__yare_old_${labelId++}`, lv.type);
            const newLocal = scope.declareLocal(`__yare_new_${labelId++}`, lv.type);
            const addr = () => mod.local.get(lv.addrLocal, binaryen.i32);
            const bumped = normalize(
              lv.type,
              arith(
                lv.type,
                expr.operator === "++" ? "add" : "sub",
                mod.local.get(oldLocal, wt),
                one_(lv.type)
              )
            );
            const steps = [
              ...lv.setup,
              mod.local.set(oldLocal, loadAt(lv.type, addr())),
              mod.local.set(newLocal, bumped),
              storeAt(lv.type, addr(), mod.local.get(newLocal, wt)),
            ];
            // prefix yields the new value, postfix the one you had, and both
            // are read out of a local so no wasm node ends up with two parents
            steps.push(mod.local.get(expr.prefix ? newLocal : oldLocal, wt));
            return blk(steps, wt);
          }
          if (expr.argument.kind !== "Identifier") {
            throw new Error("codegen: ++/-- only supported on variables, array slots, and struct fields");
          }
          const info = scope.lookup(expr.argument.name);
          const one = one_(t);
          const newVal = arith(t, expr.operator === "++" ? "add" : "sub", mod.local.get(info.index, wasmType(t)), one);
          // an i8 at 127 that increments has to come back as -128, not 128
          const setOp = mod.local.set(info.index, normalize(t, newVal));
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
        if (expr.target.kind === "IndexExpr" || expr.target.kind === "MemberExpr") {
          const lv = compileLvalue(expr.target, scope);
          const wt = wasmType(lv.type);
          const valueType = (expr.value as any).inferredType as YType;
          let value = castTo(lv.type, valueType, compileExpr(expr.value, scope));
          if (expr.operator !== "=") {
            // `xs[i] += 2` reads the slot, does the maths, writes it back
            const op = expr.operator.replace("=", "");
            const current = loadAt(lv.type, mod.local.get(lv.addrLocal, binaryen.i32));
            value = compileBinary(op, lv.type, lv.type, current, value);
          }
          const store = storeAt(lv.type, mod.local.get(lv.addrLocal, binaryen.i32), normalize(lv.type, value));
          return blk(
            [...lv.setup, store, loadAt(lv.type, mod.local.get(lv.addrLocal, binaryen.i32))],
            wt
          );
        }
        if (expr.target.kind !== "Identifier") {
          throw new Error("codegen: that is not somewhere a value can be put");
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
        if (expr.resolvedKind === "struct") {
          // `Point(1, 2)` is not a call at all: it is an allocation followed by
          // one store per field, which is why it needs no function to exist.
          ensureHeap();
          const struct = checked.structs.get(calleeName)!;
          const ptrLocal = scope.declareLocal(`__yare_obj_${labelId++}`, "int");
          const steps: number[] = [
            mod.local.set(
              ptrLocal,
              mod.call("__yare_alloc", [mod.i32.const(struct.size)], binaryen.i32)
            ),
          ];
          expr.args.forEach((arg, idx) => {
            const field = struct.fields[idx];
            const argType = (arg as any).inferredType as YType;
            const value = normalize(field.type, castTo(field.type, argType, compileExpr(arg, scope)));
            steps.push(
              storeAt(
                field.type,
                mod.i32.add(mod.local.get(ptrLocal, binaryen.i32), mod.i32.const(field.offset)),
                value
              )
            );
          });
          steps.push(mod.local.get(ptrLocal, binaryen.i32));
          return blk(steps, binaryen.i32);
        }
        // user function
        const args = expr.args.map((a) => compileExpr(a, scope));
        return mod.call(calleeName, args, wasmType(expr.inferredType as YType));
      }
    }
  }

  function zero(t: YType): number {
    if (t === "long" || t === "u64") return mod.i64.const(0, 0);
    if (t === "float") return mod.f32.const(0);
    if (t === "double") return mod.f64.const(0);
    return mod.i32.const(0);
  }

  function one_(t: YType): number {
    if (t === "long" || t === "u64") return mod.i64.const(1, 0);
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
      if (operator === "+" && (lt === "char" || rt === "char")) {
        // One string, one char. The char goes on whichever end you wrote it.
        return lt === "string"
          ? mod.call("__yare_str_push_char", [l, r], binaryen.i32)
          : mod.call("__yare_char_push_str", [l, r], binaryen.i32);
      }
      switch (operator) {
        case "+":
          return mod.call("__yare_str_concat", [l, r], binaryen.i32);
        case "==":
          return mod.call("__yare_str_eq", [l, r], binaryen.i32);
        case "!=":
          return mod.i32.eqz(mod.call("__yare_str_eq", [l, r], binaryen.i32));
        case "<":
        case ">":
        case "<=":
        case ">=":
          return strCompare(operator, l, r);
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
        // Short circuit, the way every language you have used does it. `i <
        // s.length && s[i] == x` is the idiom that guards an index, and an
        // i32.and would evaluate both sides and trap on the one you were
        // trying to avoid.
        return mod.if(lv, rv, mod.i32.const(0));
      case "||":
        return mod.if(lv, mod.i32.const(1), rv);
      default:
        throw new Error(`codegen: unsupported binary operator '${operator}'`);
    }
  }

  function arith(t: YType, op: "add" | "sub", a: number, b: number): number {
    return binOps(t)[op](a, b);
  }

  function binOps(t: YType) {
    // the narrow signed types all share int's instructions; normalize() keeps
    // their results inside the type after the fact
    if (t === "u8" || t === "u16" || t === "u32") {
      return {
        add: mod.i32.add,
        sub: mod.i32.sub,
        mul: mod.i32.mul,
        div: mod.i32.div_u,
        rem: mod.i32.rem_u,
        eq: mod.i32.eq,
        ne: mod.i32.ne,
        lt: mod.i32.lt_u,
        gt: mod.i32.gt_u,
        le: mod.i32.le_u,
        ge: mod.i32.ge_u,
      };
    }
    if (t === "u64") {
      return {
        add: mod.i64.add,
        sub: mod.i64.sub,
        mul: mod.i64.mul,
        div: mod.i64.div_u,
        rem: mod.i64.rem_u,
        eq: mod.i64.eq,
        ne: mod.i64.ne,
        lt: mod.i64.lt_u,
        gt: mod.i64.gt_u,
        le: mod.i64.le_u,
        ge: mod.i64.ge_u,
      };
    }
    if (t === "i8" || t === "i16" || t === "int" || t === "bool" || t === "char") {
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
    case "IndexExpr":
      walk(node.object, visit);
      walk(node.index, visit);
      break;
    case "ArrayLiteral":
      node.elements.forEach((e) => walk(e, visit));
      break;
    case "NewArrayExpr":
      walk(node.size, visit);
      break;
    case "StructDecl":
      break;
    case "MemberExpr":
      walk(node.object, visit);
      break;
    default:
      break;
  }
}
