import * as fs from "fs";
import * as path from "path";
import { check, CheckedProgram } from "./checker/checker";
import * as N from "./ast/nodes";
import { generateWasm } from "./codegen/codegen";
import { generateLoaderJs, generateBrowserLoaderJs } from "./runtime/loader-template";
import { resolveModules } from "./modules/resolve";
import { linkModules, LinkedModule } from "./deps/link";
import { YareConfig } from "./cli/config";

export interface BuildOptions {
  root: string;
  config: YareConfig;
  emitWat?: boolean;
}

export interface BuildResult {
  outDir: string;
  wasmPath: string;
  loaderPath: string;
  browserLoaderPath: string;
  watPath?: string;
  exportedFunctions: string[];
  /** Every .ys file that went into the build, dependencies first. */
  sourceFiles: string[];
  /** Modules pulled in by @modules.import, with what was actually linked. */
  modules: LinkedModule[];
  /** Path of the lock file written next to the build output. */
  lockPath: string;
}

/** What `config-lock.yare` records, so a build can be reproduced later. */
interface LockFile {
  name: string;
  version: string;
  target: string;
  generatedBy: string;
  modules: {
    name: string;
    version: string;
    dep: string;
    sourceHash: string;
    linked: string[];
    available: number;
  }[];
}

export interface FrontEndResult {
  /** the flattened program, module functions already pulled in */
  program: N.Program;
  checked: CheckedProgram;
  /** every .ys file that went in, dependencies first */
  files: string[];
  modules: LinkedModule[];
}

/**
 * Everything up to and including the type checker: resolve imports, link the
 * modules you asked for, check the result. `build` runs this and then emits;
 * `yare check` runs this and then stops, which is the entire difference
 * between them.
 *
 * Pass `write: false` and not even the .yare.dep object files touch the disk.
 */
export function frontEnd(opts: {
  root: string;
  config: YareConfig;
  write?: boolean;
}): FrontEndResult {
  const entryPath = path.resolve(opts.root, opts.config.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry file not found: ${entryPath} (check "entry" in config.yare)`);
  }
  const { program, files } = resolveModules(entryPath);
  const outDir = path.resolve(opts.root, opts.config.outDir);
  if (opts.write !== false) fs.mkdirSync(outDir, { recursive: true });
  const linked = linkModules(program, { outDir, write: opts.write });
  return { program: linked.program, checked: check(linked.program), files, modules: linked.modules };
}

/**
 * The whole yarescript build pipeline:
 *   .ys source -> tokens -> AST -> type-checked AST -> WebAssembly (binaryen)
 *
 * Output lands in <outDir> (".yarescript" by default) next to a tiny loader.js,
 * which is the only JavaScript involved anywhere in this repo's output. If you
 * find application logic in that loader, that is a bug worth reporting.
 */
export function build(opts: BuildOptions): BuildResult {
  // Resolve, link, and check first: everything past this line emits files, and
  // none of them should be written for a program that does not type check.
  const front = frontEnd({ root: opts.root, config: opts.config });
  const { files, modules: linkedModules } = front;
  const checked = front.checked;

  const outDir = path.resolve(opts.root, opts.config.outDir);
  const result = generateWasm(checked);

  const lockPath = path.join(outDir, "config-lock.yare");
  const lock: LockFile = {
    name: opts.config.name,
    version: opts.config.version,
    target: opts.config.target,
    generatedBy: "yare 0.1.0",
    modules: linkedModules.map((m) => ({
      name: m.name,
      version: m.version,
      dep: path.relative(outDir, m.depPath),
      sourceHash: m.sourceHash,
      linked: m.linked,
      available: m.available,
    })),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");

  const wasmFileName = `${opts.config.name}.wasm`;
  const wasmPath = path.join(outDir, wasmFileName);
  fs.writeFileSync(wasmPath, result.wasmBinary);

  const exportedFunctions = [...checked.functions.entries()]
    .filter(([, sig]) => sig.visibility === "public")
    .map(([name]) => name);

  const loaderJs = generateLoaderJs({
    wasmFileName,
    exportedFunctions,
    usedHostFunctions: result.usedHostFunctions,
  });
  const loaderPath = path.join(outDir, "loader.js");
  fs.writeFileSync(loaderPath, loaderJs);

  const browserLoaderJs = generateBrowserLoaderJs({
    wasmFileName,
    usedHostFunctions: result.usedHostFunctions,
  });
  const browserLoaderPath = path.join(outDir, "loader.browser.js");
  fs.writeFileSync(browserLoaderPath, browserLoaderJs);

  let watPath: string | undefined;
  if (opts.emitWat) {
    watPath = path.join(outDir, `${opts.config.name}.wat`);
    fs.writeFileSync(watPath, result.wat);
  }

  return {
    outDir,
    wasmPath,
    loaderPath,
    browserLoaderPath,
    watPath,
    exportedFunctions,
    sourceFiles: files,
    modules: linkedModules,
    lockPath,
  };
}
