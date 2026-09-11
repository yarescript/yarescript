import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parse } from "../parser/parser";
import * as N from "../ast/nodes";

/**
 * A `.yare.dep` file: an object file, but for WebAssembly.
 *
 * It carries a compiled dependency's function index, a hash of the source it
 * came from, and enough of the source to hand individual functions to the
 * linker. That last part is the reason it exists: linking a whole library
 * because you called three of its functions is how bundles get fat, so the
 * linker takes only the functions you actually called.
 */
export const DEP_MAGIC = "yare.dep";
export const DEP_VERSION = 1;
export const DEP_EXTENSION = ".yare.dep";

export interface DepFunction {
  name: string;
  params: { type: string; name: string }[];
  returnType: string;
  /** 1-based first line of the declaration in `source`. */
  startLine: number;
  /** 1-based last line of the declaration in `source`. */
  endLine: number;
}

export interface DepFile {
  magic: string;
  version: number;
  name: string;
  depVersion: string;
  abi: number;
  sourceHash: string;
  source: string;
  functions: DepFunction[];
}

export function hashSource(source: string): string {
  return "sha256:" + crypto.createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16);
}

/** Compile one module's source into a dep file. Nothing is thrown away. */
export function buildDepFile(
  moduleName: string,
  source: string,
  depVersion = "0.1.0"
): DepFile {
  const program = parse(source, `${moduleName}.ys`);
  const lines = source.split("\n");
  const functions: DepFunction[] = [];

  for (const decl of program.body) {
    if (decl.kind !== "FunctionDecl") continue;
    functions.push({
      name: decl.name,
      params: decl.params.map((p) => ({ type: p.paramType.name, name: p.name })),
      returnType: decl.returnType.name,
      startLine: decl.line,
      endLine: decl.body.endLine,
    });
  }

  return {
    magic: DEP_MAGIC,
    version: DEP_VERSION,
    name: moduleName,
    depVersion,
    abi: DEP_VERSION,
    sourceHash: hashSource(source),
    source: lines.join("\n"),
    functions,
  };
}

export function writeDepFile(dir: string, dep: DepFile): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dep.name}${DEP_EXTENSION}`);
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n", "utf8");
  return file;
}

export function readDepFile(file: string): DepFile {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as DepFile;
  if (raw.magic !== DEP_MAGIC) {
    throw new Error(`${file} is not a ${DEP_MAGIC} file`);
  }
  if (raw.abi !== DEP_VERSION) {
    throw new Error(
      `${file} was built for dep abi ${raw.abi}, this compiler speaks ${DEP_VERSION}. Rebuild it.`
    );
  }
  return raw;
}

/** The source text of a single function, sliced out of the dep file. */
export function functionSource(dep: DepFile, name: string): string | null {
  const fn = dep.functions.find((f) => f.name === name);
  if (!fn) return null;
  return dep.source.split("\n").slice(fn.startLine - 1, fn.endLine).join("\n");
}

/** Parse a sliced function back into an AST node. */
export function parseFunction(source: string, fileName: string): N.FunctionDecl {
  const program = parse(source, fileName);
  const decl = program.body.find((d): d is N.FunctionDecl => d.kind === "FunctionDecl");
  if (!decl) throw new Error(`No function found in ${fileName}`);
  return decl;
}
