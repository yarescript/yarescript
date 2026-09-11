import * as fs from "fs";
import * as path from "path";
import { parse } from "./parser/parser";
import { check } from "./checker/checker";
import { generateWasm } from "./codegen/codegen";
import { generateLoaderJs, generateBrowserLoaderJs } from "./runtime/loader-template";
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
}

/**
 * The whole yarescript build pipeline:
 *   .ys source -> tokens -> AST -> type-checked AST -> WebAssembly (binaryen)
 * The output lands in <outDir> (".yarescript" by default) alongside a
 * tiny loader.js that is the only JavaScript involved anywhere.
 */
export function build(opts: BuildOptions): BuildResult {
  const entryPath = path.resolve(opts.root, opts.config.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry file not found: ${entryPath} (check "entry" in config.yare)`);
  }
  const source = fs.readFileSync(entryPath, "utf8");

  const program = parse(source, path.relative(opts.root, entryPath));
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

  return { outDir, wasmPath, loaderPath, browserLoaderPath, watPath, exportedFunctions };
}
