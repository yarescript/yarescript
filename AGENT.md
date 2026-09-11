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
node dist/cli/index.js build           # from inside an examples/ project
node dist/cli/index.js run
node dist/cli/index.js test
node dist/cli/index.js fmt --check
```

`npm test` runs the compiled JavaScript in `dist/`, so a stale `dist/` means
stale results. Run `npm run build` first, always.

There are 42 tests and they are the real thing: they compile yarescript source,
instantiate the WebAssembly, execute it, and assert on what the program printed.
Do not replace that with a test that only checks "it compiled".

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
stdlib/           str.ys, math.ys, json.ys   modules for @modules.import
src/fmt/          formatter.ts               `yare fmt`
src/test-runner/  runner.ts                  `yare test`
src/cli/          config.ts, index.ts        config.yare and the yare command
src/test/         *.test.ts                  the test suite
examples/         hello-world, kitchen-sink, modules
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
- **Strings are a `u32` length followed by UTF-8 bytes**, and the heap is a
  bump allocator starting right after the string table. There is no collector
  yet, so a program that concatenates in a loop grows memory until the host
  says no.

## Style

- Comments should be funny and correct, in that order. A joke that misdescribes
  the code is worse than no joke, because somebody will believe it.
- Docs are plain ASCII: no emoji, no en or em dashes, no arrow glyphs. Write
  `->` and use plain words.
- Docs talk to the reader. "You compile with `yare build`", not "I decided to
  build it this way".
- Nothing in this repo mentions how any of it was written. No tool
  attributions, no generation notes, no meta-commentary.
- Commit messages are lazy and short. `docs cleanup` is a complete commit
  message.

## Not implemented yet

The narrow and unsigned numeric widths (`u8` through `u64`, `i8`, `i16`),
structs, generics, arrays, a garbage collector, source maps, a WASI target, an
editor extension, a real registry behind `libs` in `config.yare`, parsing json
and xml and toml documents rather than building them, and publishing to npm.
The current list lives in `ROADMAP.md`, which is the file to update when any of
that changes.
