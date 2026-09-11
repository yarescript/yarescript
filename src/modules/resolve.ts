import * as fs from "fs";
import * as path from "path";
import { parse } from "../parser/parser";
import * as N from "../ast/nodes";

export class ModuleError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface ResolvedProgram {
  /** Every declaration from the entry file and everything it imports. */
  program: N.Program;
  /** Absolute paths in dependency-first order: imported files, then importer. */
  files: string[];
}

/**
 * Reads the entry file, follows every `import { x } from "./file.ys"` it finds,
 * and flattens the whole graph into one program.
 *
 * There is no linking step and no symbol table in this file on purpose: the
 * checker already knows how to complain about duplicates and unknown names,
 * and it does it with better error messages than a second implementation
 * would. This module's job is reading files, spotting cycles, and refusing to
 * let you import a name that does not exist.
 */
export function resolveModules(entryPath: string): ResolvedProgram {
  const parsed = new Map<string, N.Program>();
  const order: string[] = [];
  const onStack = new Set<string>();

  const display = (abs: string) => path.relative(process.cwd(), abs) || abs;

  function visit(abs: string, chain: string[]): void {
    if (parsed.has(abs)) {
      if (onStack.has(abs)) {
        const loop = [...chain, abs].map(display).join(" -> ");
        throw new ModuleError(`Circular import: ${loop}`);
      }
      return; // diamond imports are fine, everybody gets the same copy
    }
    if (!fs.existsSync(abs)) {
      const importer = chain[chain.length - 1];
      throw new ModuleError(
        `Cannot find module '${display(abs)}'${importer ? ` imported by ${display(importer)}` : ""}`
      );
    }
    const source = fs.readFileSync(abs, "utf8");
    const program = parse(source, display(abs));
    parsed.set(abs, program);
    onStack.add(abs);

    for (const decl of program.body) {
      if (decl.kind !== "ImportDecl") continue;
      const target = resolveImport(abs, decl.from);
      visit(target, [...chain, abs]);

      // Refuse imports of names the target file never declared, here and now,
      // rather than letting the checker discover it three files later.
      const available = new Set<string>();
      for (const d of parsed.get(target)!.body) {
        if (d.kind === "FunctionDecl" || d.kind === "VarDecl") available.add(d.name);
      }
      for (const name of decl.names) {
        if (!available.has(name)) {
          throw new ModuleError(
            `'${decl.from}' does not define '${name}' (imported by ${display(abs)})`
          );
        }
      }
    }

    onStack.delete(abs);
    order.push(abs);
  }

  visit(path.resolve(entryPath), []);

  const body: N.Program["body"] = [];
  for (const abs of order) {
    for (const decl of parsed.get(abs)!.body) {
      if (decl.kind === "ImportDecl") continue;
      body.push(decl);
    }
  }
  return { program: { kind: "Program", body }, files: order };
}

/** `"./helper"` means `"./helper.ys"`. Anything else is taken literally. */
function resolveImport(fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (!path.extname(spec) && fs.existsSync(base + ".ys")) return base + ".ys";
  return base;
}

/** Every `.ys` file under a directory, sorted, node_modules politely ignored. */
export function findSourceFiles(rootDir: string, filter?: (file: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ys") && (!filter || filter(full))) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out.sort();
}
