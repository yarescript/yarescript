#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { build } from "../compiler";
import { defaultConfig, findConfig, loadConfig, writeConfig, DEFAULT_CONFIG_FILENAME } from "./config";
import { LexError } from "../lexer/lexer";
import { ParseError } from "../parser/parser";
import { TypeError_ } from "../checker/checker";
import { ModuleError, findSourceFiles } from "../modules/resolve";
import { format } from "../fmt/formatter";
import { runTestFile } from "../test-runner/runner";

const VERSION = "0.1.0";

function usage() {
  console.log(`yarescript ${VERSION} - a compiled language for the web. Compiles .ys source to WebAssembly.

Usage:
  yare init [name]        Scaffold a new yarescript project (writes ${DEFAULT_CONFIG_FILENAME})
  yare build [--wat]      Compile the project entry to WebAssembly + a tiny JS loader
  yare run [--wat]        Build, then execute the compiled program in Node
  yare fmt [--check]      Reformat every .ys file in the project (--check only reports)
  yare test               Run every public test* function in every *.test.ys file
  yare version            Print the compiler version

yarescript is written by Arunkumar (github.com/Seigh-sword) and maintained
by Surya (github.com/suripewepedie).
`);
}

// Errors the compiler understands get a tidy red one-liner. Anything else is a
// compiler bug and gets the full stack trace it deserves.
function fail(message: string): never {
  console.error(`\x1b[31merror:\x1b[0m ${message}`);
  process.exit(1);
}

function loadProjectConfig() {
  const configPath = findConfig(process.cwd());
  if (!configPath) {
    fail(`No ${DEFAULT_CONFIG_FILENAME} found. Run "yare init" to create one.`);
  }
  return loadConfig(configPath!);
}

function cmdInit(name?: string) {
  const configPathExisting = path.join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(configPathExisting)) {
    fail(`${DEFAULT_CONFIG_FILENAME} already exists in this directory.`);
  }
  const projectName = name ?? path.basename(process.cwd());
  const config = defaultConfig(projectName);
  writeConfig(process.cwd(), config);

  const entryDir = path.dirname(path.join(process.cwd(), config.entry));
  fs.mkdirSync(entryDir, { recursive: true });
  const entryFile = path.join(process.cwd(), config.entry);
  if (!fs.existsSync(entryFile)) {
    fs.writeFileSync(
      entryFile,
      `public function: void main() {\n    console.log("hello, world");\n}\n`
    );
  }

  console.log(`Created ${DEFAULT_CONFIG_FILENAME} and ${config.entry}`);
  console.log(`Next: yare build`);
}

function cmdBuild(flags: Set<string>) {
  const { config, root } = loadProjectConfig();
  try {
    const result = build({ root, config, emitWat: flags.has("--wat") });
    console.log(`Compiled ${config.entry} -> ${path.relative(root, result.wasmPath)}`);
    console.log(`Loader:   ${path.relative(root, result.loaderPath)}`);
    if (result.watPath) console.log(`WAT:      ${path.relative(root, result.watPath)}`);
    if (result.sourceFiles.length > 1) console.log(`Sources:  ${result.sourceFiles.length} files`);
    for (const m of result.modules) {
      console.log(
        `Module:   ${m.name} ${m.version} (${m.linked.length} of ${m.available} functions linked)`
      );
    }
    if (result.modules.length) console.log(`Lock:     ${path.relative(root, result.lockPath)}`);
    console.log(`Exports:  ${result.exportedFunctions.join(", ") || "(none)"}`);
  } catch (err) {
    reportCompileError(err);
  }
}

async function cmdRun(flags: Set<string>) {
  const { config, root } = loadProjectConfig();
  try {
    const result = build({ root, config, emitWat: flags.has("--wat") });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadYarescriptModule } = require(result.loaderPath);
    const mod = await loadYarescriptModule();
    if (typeof mod.main !== "function") {
      fail(`Entry file has no public "main" function to run.`);
    }
    mod.main();
  } catch (err) {
    reportCompileError(err);
  }
}

function cmdFmt(flags: Set<string>, files: string[]) {
  const { root } = loadProjectConfig();
  const targets = files.length
    ? files.map((f) => path.resolve(root, f))
    : findSourceFiles(root);
  if (!targets.length) {
    console.log("No .ys files to format.");
    return;
  }
  const checkOnly = flags.has("--check");
  let changed = 0;
  for (const file of targets) {
    const original = fs.readFileSync(file, "utf8");
    let formatted: string;
    try {
      formatted = format(original, path.relative(root, file));
    } catch (err) {
      reportCompileError(err);
    }
    if (formatted === original) continue;
    changed++;
    const rel = path.relative(process.cwd(), file);
    if (checkOnly) {
      console.log(`would reformat ${rel}`);
    } else {
      fs.writeFileSync(file, formatted, "utf8");
      console.log(`reformatted ${rel}`);
    }
  }
  if (checkOnly && changed) {
    console.error(`\x1b[31merror:\x1b[0m ${changed} file(s) need formatting. Run "yare fmt".`);
    process.exit(1);
  }
  if (!changed) console.log(checkOnly ? "All formatted already." : "Nothing to do.");
}

async function cmdTest() {
  const { root } = loadProjectConfig();
  const files = findSourceFiles(root, (f) => f.endsWith(".test.ys"));
  if (!files.length) {
    console.log(`No *.test.ys files under ${path.relative(process.cwd(), root) || "."}.`);
    return;
  }
  let pass = 0;
  let fail = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let results;
    try {
      results = await runTestFile(file);
    } catch (err) {
      reportCompileError(err);
    }
    if (!results.length) console.log(`${rel}: no test functions`);
    for (const r of results) {
      if (r.ok) {
        pass++;
        console.log(`ok    ${r.name} (${rel})`);
      } else {
        fail++;
        console.error(`\x1b[31mFAIL\x1b[0m  ${r.name} (${rel}): ${r.error}`);
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

function reportCompileError(err: unknown): never {
  if (
    err instanceof LexError ||
    err instanceof ParseError ||
    err instanceof TypeError_ ||
    err instanceof ModuleError
  ) {
    fail(err.message);
  }
  throw err;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "init":
      cmdInit(positional[0]);
      break;
    case "build":
      cmdBuild(flags);
      break;
    case "run":
      await cmdRun(flags);
      break;
    case "fmt":
      cmdFmt(flags, positional);
      break;
    case "test":
      await cmdTest();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("\x1b[31mInternal compiler error:\x1b[0m", err);
  process.exit(1);
});
