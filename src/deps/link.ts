import * as fs from "fs";
import * as path from "path";
import * as N from "../ast/nodes";
import { ModuleError } from "../modules/resolve";
import { didYouMean } from "../diagnostics/suggest";
import {
  buildDepFile,
  functionSource,
  parseFunction,
  structSource,
  writeDepFile,
  DepFile,
} from "./depfile";
import { parseStruct } from "../parser/parser";

export interface LinkedModule {
  name: string;
  version: string;
  /** Path of the .yare.dep file that was written or reused. */
  depPath: string;
  sourceHash: string;
  /** Functions actually pulled into the build. */
  linked: string[];
  /** Functions the module offers in total. */
  available: number;
}

export interface LinkReport {
  program: N.Program;
  modules: LinkedModule[];
}

const NAMESPACE = "modules";
const ACTION = "import";

/** Where the bundled modules live, relative to the compiled compiler. */
export function stdlibDir(): string {
  return path.resolve(__dirname, "..", "..", "stdlib");
}

export function availableModules(dir: string = stdlibDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ys"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** `str.upper` becomes `__mod_str_upper` inside the linked module. */
export function internalName(moduleName: string, fn: string): string {
  return `__mod_${moduleName}_${fn}`;
}

/**
 * Turns `@modules.import("str")` plus calls like `str.upper(s)` into a single
 * program, pulling in only the functions you called.
 *
 * Import a module and never touch it and nothing is linked. Call three of its
 * functions and three functions land in your wasm, not the whole library.
 */
export function linkModules(
  program: N.Program,
  opts: { outDir: string; stdlib?: string; write?: boolean }
): LinkReport {
  const dir = opts.stdlib ?? stdlibDir();
  const depBuildDir = path.join(opts.outDir, "dep", "build");
  const known = availableModules(dir);
  const imported: string[] = [];

  for (const decl of program.body) {
    if (decl.kind !== "DirectiveDecl") continue;
    if (decl.namespace !== NAMESPACE) {
      throw new ModuleError(
        `Unknown directive '@${decl.namespace}'. Did you mean '@${NAMESPACE}.${ACTION}'?`
      );
    }
    if (decl.action !== ACTION) {
      throw new ModuleError(
        `Unknown directive '@${decl.namespace}.${decl.action}'. Did you mean '@${NAMESPACE}.${ACTION}'?`
      );
    }
    for (const name of decl.args) {
      if (!known.includes(name)) {
        throw new ModuleError(
          `Unknown module '${name}'.${didYouMean(name, known)}` +
            ` Available modules: ${known.join(", ") || "(none)"}`
        );
      }
      if (!imported.includes(name)) imported.push(name);
    }
  }

  const wanted = new Map<string, Set<string>>();
  for (const name of imported) wanted.set(name, new Set());
  walk(program, (node) => {
    const call = qualifiedCall(node, imported);
    if (call) wanted.get(call.moduleName)!.add(call.fn);
  });

  const modules: LinkedModule[] = [];
  const linked: N.FunctionDecl[] = [];
  const linkedTypes: N.StructDecl[] = [];

  for (const name of imported) {
    const source = fs.readFileSync(path.join(dir, `${name}.ys`), "utf8");
    const dep = buildDepFile(name, source);
    // `yare check` links without writing: it promises to emit nothing, and a
    // .yare.dep file is definitely something.
    const depPath =
      opts.write === false
        ? path.join(depBuildDir, `${dep.name}.yare.dep`)
        : writeDepFile(depBuildDir, dep);

    const asked = [...wanted.get(name)!];
    const offered = dep.functions.map((f) => f.name);
    for (const fn of asked) {
      if (!offered.includes(fn)) {
        throw new ModuleError(
          `Module '${name}' has no function '${fn}'.${didYouMean(fn, offered)}` +
            ` It offers: ${offered.join(", ")}`
        );
      }
    }

    const selected = expand(dep, asked);
    // Types travel with the functions that mention them. A module's structs
    // join your program under their own name, so `json.parse` can hand you a
    // `Value` you are able to declare a variable of.
    for (const typeName of referencedStructs(dep, selected)) {
      const decl = parseStruct(structSource(dep, typeName)!, `${name}.ys`);
      linkedTypes.push(decl);
    }
    for (const fn of selected) {
      const decl = parseFunction(functionSource(dep, fn)!, `${name}.ys`);
      decl.name = internalName(name, fn);
      // Module functions are internals of your build, not part of its API.
      decl.visibility = "private";
      renameSiblingCalls(decl, name, new Set(selected));
      linked.push(decl);
    }

    modules.push({
      name,
      version: dep.depVersion,
      depPath,
      sourceHash: dep.sourceHash,
      linked: selected,
      available: offered.length,
    });
  }

  const body: N.Program["body"] = [];
  for (const decl of program.body) {
    if (decl.kind === "DirectiveDecl") continue;
    walk(decl, (node) => {
      if (node.kind !== "CallExpr") return;
      const call = qualifiedCall(node, imported);
      if (call) {
        node.callee = {
          kind: "Identifier",
          name: internalName(call.moduleName, call.fn),
          line: node.line,
        };
      }
    });
    body.push(decl);
  }

  return { program: { kind: "Program", body: [...linkedTypes, ...linked, ...body] }, modules };
}

/**
 * Every struct a set of functions depends on, in the order the module declared
 * them, which is the order they have to be re-declared in: a struct may only
 * contain types that already exist.
 */
function referencedStructs(dep: DepFile, selected: string[]): string[] {
  const declared = (dep.structs ?? []).map((st) => st.name);
  const wanted = new Set<string>();
  const queue: string[] = [];
  const add = (name: string) => {
    if (declared.includes(name) && !wanted.has(name)) {
      wanted.add(name);
      queue.push(name);
    }
  };

  for (const fn of selected) {
    const src = functionSource(dep, fn);
    if (!src) continue;
    const decl = parseFunction(src, `${dep.name}.ys`);
    add(decl.returnType.name);
    decl.params.forEach((p) => add(p.paramType.name));
    walk(decl.body, (node) => {
      if (node.kind === "VarDecl" && node.varType) add(node.varType.name);
      else if (node.kind === "CastExpr") add(node.targetType.name);
      else if (node.kind === "NewArrayExpr") add(node.elemType.name);
    });
  }

  // and whatever those structs are built out of
  while (queue.length) {
    const name = queue.shift()!;
    const src = structSource(dep, name);
    if (!src) continue;
    for (const field of parseStruct(src, `${dep.name}.ys`).fields) add(field.fieldType.name);
  }

  return declared.filter((name) => wanted.has(name));
}

/** A module function, plus the module functions it calls, plus theirs. */
function expand(dep: DepFile, asked: string[]): string[] {
  const selected = new Set<string>(asked);
  const queue = [...asked];
  while (queue.length) {
    const name = queue.shift()!;
    const src = functionSource(dep, name);
    if (!src) continue;
    const decl = parseFunction(src, `${dep.name}.ys`);
    walk(decl, (node) => {
      if (node.kind !== "CallExpr" || node.callee.kind !== "Identifier") return;
      const callee = node.callee.name;
      if (dep.functions.some((f) => f.name === callee) && !selected.has(callee)) {
        selected.add(callee);
        queue.push(callee);
      }
    });
  }
  return [...selected];
}

function renameSiblingCalls(decl: N.FunctionDecl, moduleName: string, selected: Set<string>) {
  walk(decl, (node) => {
    if (node.kind !== "CallExpr" || node.callee.kind !== "Identifier") return;
    if (selected.has(node.callee.name)) {
      node.callee.name = internalName(moduleName, node.callee.name);
    }
  });
}

function qualifiedCall(node: N.Node, modules: string[]): { moduleName: string; fn: string } | null {
  if (node.kind !== "CallExpr" || node.callee.kind !== "MemberExpr") return null;
  const obj = node.callee.object;
  if (obj.kind !== "Identifier" || !modules.includes(obj.name)) return null;
  return { moduleName: obj.name, fn: node.callee.property };
}

/** Depth-first walk over every node, mutating in place where the visitor asks. */
export function walk(node: N.Node, visit: (n: N.Node) => void): void {
  visit(node);
  switch (node.kind) {
    case "Program":
      node.body.forEach((n) => walk(n as N.Node, visit));
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
    case "CastExpr":
      walk(node.expr, visit);
      break;
    case "IndexExpr":
      walk(node.object, visit);
      walk(node.index, visit);
      break;
    case "CallExpr":
      walk(node.callee, visit);
      node.args.forEach((a) => walk(a, visit));
      break;
    case "MemberExpr":
      walk(node.object, visit);
      break;
    default:
      break;
  }
}
