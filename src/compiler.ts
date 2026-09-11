import * as fs from "fs";
import * as path from "path";
import { check } from "./checker/checker";
import { generateWasm } from "./codegen/codegen";
import { generateLoaderJs, generateBrowserLoaderJs } from "./runtime/loader-template";
import { resolveModules } from "./modules/resolve";
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
  const checked = check(program);
  const result = generateWasm(checked);

  const outDir = path.resolve(opts.root, opts.config.outDir);
  fs.mkdirSync(outDir, { recursive: true });

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
  };
}
