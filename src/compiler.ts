import * as fs from "fs";
import * as path from "path";
import { check } from "./checker/checker";
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

/**
 * The whole yarescript build pipeline:
 *   .ys source -> tokens -> AST -> type-checked AST -> WebAssembly (binaryen)
 *
 * Output lands in <outDir> (".yarescript" by default) next to a tiny loader.js,
 * which is the only JavaScript involved anywhere in this repo's output. If you
 * find application logic in that loader, that is a bug worth reporting.
 */
export function build(opts: BuildOptions): BuildResult {
  const entryPath = path.resolve(opts.root, opts.config.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry file not found: ${entryPath} (check "entry" in config.yare)`);
  }

  // The entry file and everything it imports, flattened into one program.
  const { program, files } = resolveModules(entryPath);

  const outDir = path.resolve(opts.root, opts.config.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // @modules.import: compile the modules you asked for into .yare.dep object
  // files, then pull in only the functions you actually call.
  const linked = linkModules(program, { outDir });
  const checked = check(linked.program);
  const result = generateWasm(checked);

  const lockPath = path.join(outDir, "config-lock.yare");
  const lock: LockFile = {
    name: opts.config.name,
    version: opts.config.version,
    target: opts.config.target,
    generatedBy: "yare 0.1.0",
    modules: linked.modules.map((m) => ({
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
    modules: linked.modules,
    lockPath,
  };
}
