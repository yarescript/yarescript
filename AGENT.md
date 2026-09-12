# AGENT.md

Notes for anybody (human or agent) working in this repo. Read this before
touching the compiler.

## What this is

yarescript is a statically typed language that compiles to WebAssembly. `yare`
is its first compiler, written in TypeScript, and it lives in this repo. The
language is open, so `yare` is a reference implementation rather than the only
one.

The whole point of the project is that your program becomes WebAssembly
bytecode. The only JavaScript yarescript produces is a small fixed-size loader.
If a change makes the loader grow with the user's program, the change is wrong
no matter how convenient it was.

## People

- Arunkumar ([github.com/Seigh-sword](https://github.com/Seigh-sword)) writes
  the code and fixes the bugs.
- Surya ([github.com/suripewepedie](https://github.com/suripewepedie))
  maintains the project: watching for errors, testing builds and examples,
  keeping releases working.

Compiler bugs go to Arunkumar. Broken releases, examples, and docs go to Surya.

## Commands that matter

```bash
npm install
npm run build                          # tsc, src/ -> dist/
npm test                               # node --test dist/test/*.test.js
node dist/cli/index.js check           # from inside an examples/ project
node dist/cli/index.js build
node dist/cli/index.js run
node dist/cli/index.js test
node dist/cli/index.js fmt --check
```

`npm test` runs the compiled JavaScript in `dist/`, so a stale `dist/` means
stale results. Run `npm run build` first, always.

The suite is the real thing: every test compiles yarescript source,
instantiates the WebAssembly, runs it, and asserts on what the program printed.
`npm test` prints the count, so read it rather than trusting memory. Do not
replace that with a test that only checks "it compiled".

## Layout

```
src/lexer/        tokens.ts, lexer.ts        source -> tokens
src/parser/       parser.ts                  tokens -> AST (recursive descent)
src/ast/          nodes.ts                   the AST node definitions
src/checker/      types.ts, checker.ts       types, scopes, error messages
src/codegen/      codegen.ts                 AST -> WebAssembly via binaryen
src/runtime/      loader-template.ts         generates loader.js (the only JS)
src/modules/      resolve.ts                 import resolution, .ys file walking
src/deps/         depfile.ts, link.ts        .yare.dep files, selective linking
src/diagnostics/  suggest.ts                 "did you mean?" for every error
stdlib/           str, math, json, toml, xml  modules for @modules.import
src/fmt/          formatter.ts               `yare fmt`
src/test-runner/  runner.ts                  `yare test`
src/cli/          config.ts, index.ts        config.yare and the yare command
src/test/         *.test.ts                  the test suite
examples/         hello-world, kitchen-sink, modules, stdlib, records,
                  documents
```

## Adding a language feature

The pipeline is a straight line, and a feature is not done until every stop on
it has been visited:

1. `src/lexer/tokens.ts` if it needs a token or keyword.
2. `src/parser/parser.ts` to parse it, plus the node in `src/ast/nodes.ts`.
   Keep the precedence chain in `parseExpr` .. `parsePrimary` in order.
3. `src/checker/checker.ts` to type it. Every rule needs an error message a
   person can act on, with a line number.
4. `src/codegen/codegen.ts` to emit it, and `walk()` in the same file, which is
   how host-import scanning finds nested nodes. Forget `walk()` and the feature
   works everywhere except inside a nested block.
5. `src/runtime/loader-template.ts` if it needs a host function. Both loaders,
   Node and browser, plus `src/test/helpers.ts` so tests can run it.
6. `src/fmt/formatter.ts` so it prints back out. See the precedence note below.
7. `docs/LANGUAGE.md`, then `README.md` and `ROADMAP.md` if the status changed.
8. A test in `src/test/` that runs real code and checks real output.

## Build output

`yare build` writes `.yare/`: your `.wasm`, the two loaders, `config-lock.yare`,
and `dep/build/<module>.yare.dep` for every module you imported. A `.yare.dep`
is an object file for WebAssembly: a function index, a source hash, and the
source the linker slices individual functions out of.

Linking is per function, not per module. `str.upper` and `str.reverse` in your
code means two functions from `str.ys` in your wasm, and nothing else from it.
If you add a module function that calls a sibling, the linker follows the call;
you do not have to list it.

The bundled modules are ordinary yarescript in `stdlib/`. That is deliberate:
they go through the same compiler as your code, so they cannot rot silently.
They are also the fastest way to find out a language feature is missing.

## Things that will bite you

- **binaryen's `i64.const` takes `(low, high)`.** Hand it one argument above
  2^32 and it truncates without complaining. `i64Const()` in codegen does the
  split; use it.
- **`mod.block(null, ...)` is a type error.** The typings want a label string.
  Use the `blk()` helper in codegen for unnamed blocks.
- **`setMemory` maximum is `-1` for "no maximum".** Passing `undefined` gives
  you a maximum of 0, and the validator tells you so in a way that looks
  unrelated.
- **Widening is the checker's opinion, not an action.** The checker decides
  `int + double` is a `double`; codegen has to actually convert the operand.
  Every `local.set`, `return`, and binary operator goes through `castTo()` for
  this reason. If you add a place where a value lands in a typed slot, widen it.
- **The formatter must not change what a program means.** The parser throws
  parentheses away, so `formatter.ts` puts them back from its own precedence
  table. That table is a second copy of the parser's precedence, and the two
  must agree. `- -x` is the classic trap: print it as `--x` and you have turned
  a double negative into a decrement.
- **`@modules.import` needs the parser to accept keywords as words.** `import`
  is a keyword, so the directive parser takes any word-shaped token rather than
  only identifiers.
- **Module functions are renamed on the way in.** `str.upper` becomes
  `__mod_str_upper` and is marked private, so it is callable from your code and
  invisible to the host. If exports ever grow a `__mod_` prefix, look in
  `src/deps/link.ts`.
- **`__yare_` is reserved.** Codegen injects `__yare_alloc`,
  `__yare_str_alloc`, `__yare_str_concat`, and `__yare_str_eq` into modules
  that use string operators, and the checker rejects user functions with that
  prefix.
- **Thirteen value types ride on four WebAssembly kinds**, and `void` rides on
  none. The narrow ones (`i8`, `i16`, `u8`, `u16`) live in an `i32` and are
  clamped by `normalize()` in `src/codegen/codegen.ts` on every write,
  including `++` and `--`. The unsigned ones share a kind with their signed
  twin and differ only in the instruction `binOps()` picks: `div_u`, `lt_u`,
  and friends. Add a type in `src/checker/types.ts` and those two functions
  are where it quietly breaks if you forget them.
- **Struct layout lives in the checker, not in codegen.** `checkStructDecl`
  walks the fields, aligns each one naturally, and stores the offsets in
  `CheckedProgram.structs`. Codegen only reads them. If a field ever reads the
  wrong value, the two have disagreed, and the checker is the one to believe.
- **Arrays and strings share a header shape.** Both are a `u32` length followed
  by the data, except that eight byte elements (`long`, `u64`, `double`) get an
  eight byte header so the first element stays aligned. That is
  `arrayHeader()` in codegen, and `.length` works on both for the same reason.
- **Compound types are strings, and that is deliberate.** `YType` covers the
  fourteen scalars plus `int[]` and struct names, so `isArrayType()` and
  `elemTypeOf()` are how you ask about them. Every switch over `YType` needs a
  `default` now, which is the price of a type list you cannot write down.
- **`yare check` and `yare build` share `frontEnd()`.** Linking happens before
  checking, because `@modules.import` adds functions the checker has to know
  about. `check` passes `write: false` so a type-check emits nothing at all.
- **A bare number literal borrows the type beside it.** `Checker.adoptLiteral`
  is what lets `i + 2` typecheck on a `u8`, and `checkExprAs` is what lets
  `let: u8 m = 200;` typecheck at all, since `int` is not assignable to `u8`.
  Both consult `INT_RANGE`, the only place the bounds live.
- **Strings are a `u32` length followed by UTF-8 bytes**, and the heap is a
  bump allocator starting right after the string table. There is no collector
  yet, so a program that concatenates in a loop grows memory until the host
  says no.

## Not implemented yet

Generics, a garbage collector, source maps, a WASI target, an editor
extension, a real registry behind `libs` in `config.yare`, unicode escapes and
entity decoding in the document modules, and publishing to npm.
The current list lives in `ROADMAP.md`, which is the file to update when any of
that changes.
