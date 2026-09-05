# yarescript

**A compiled language for the web, built to fix what JavaScript broke.**

TypeScript still compiles down to JavaScript — it's a type-checked front
layer bolted onto the same runtime, the same footguns, the same "well,
technically it's still JS at 3am in production" problems.

yarescript doesn't do that. It compiles straight to **WebAssembly**. There
is no JavaScript application layer. The only JavaScript yarescript ever
produces is a teeny, fixed-size loader that instantiates your compiled
`.wasm` module and wires up a handful of host functions (like
`console.log`). Your actual program — every `if`, every loop, every
function — is real WebAssembly bytecode, running at near-native speed.

```
public function: void main() { // I didnt use, int becuase I am lazy
    console.log("hello, world");
}
```

```
$ yare build
Compiled src/main.ys -> .yarescript/hello-world.wasm
Loader:   .yarescript/loader.js
Exports:  main

$ yare run
hello, world
```

## Why

- **TypeScript fixes JS's *types*, not JS's *runtime*.** You still ship
  JavaScript. yarescript ships WebAssembly; JS is only ever the loader.
- **Fast runtime over fast compile.** yarescript leans on
  [Binaryen](https://github.com/WebAssemblyOutlines/binaryen) to emit
  optimized WebAssembly. Compiling might not be instant — running your
  program should be.
- **A tiny, fixed-size loader, not a bundle that grows with your app.**
  `.yarescript/loader.js` never changes shape. It loads whatever `.wasm`
  and libraries your program needs; it does not contain your program.
- **From scratch.** The compiler (this repo) is written in TypeScript
  today for bootstrapping speed, but the language, its type system, and
  its runtime model are entirely yarescript's own design — not a fork of
  AssemblyScript, not "TypeScript minus the parts we don't like."

## Status

Early, but real. The `.ys → WebAssembly` pipeline works end to end today:

- ✅ Lexer, recursive-descent parser, AST
- ✅ Static type checker (`int`, `long`, `float`, `double`, `bool`,
  `string`, `void`)
- ✅ Binaryen-backed codegen emitting real, runnable `.wasm`
- ✅ Functions, `let`/`const`, `if`/`else`, `while`, `for`, `break`,
  `continue`, recursion, operator precedence
- ✅ `console.log` as a host import (overloaded per type) — proof that
  yarescript can talk to the outside world without becoming JavaScript
- ✅ `yare init` / `yare build` / `yare run` CLI
- ✅ `config.yare` project manifest
- ✅ Tiny generated loader for both Node and the browser
- 🚧 String operators (`+`, `==`), arrays/objects, a real module/import
  system, a package registry for "libs" — see [ROADMAP.md](./ROADMAP.md)
- ⏳ Not yet published to npm — this is pre-release. When it ships, `yare`
  will be installable via `npm install -g yarescript`.

## Quick start (from a checkout of this repo)

```bash
npm install
npm run build        # compiles the yarescript compiler itself (TS -> dist/)

cd examples/hello-world
node ../../dist/cli/index.js build   # or, once installed: yare build
node ../../dist/cli/index.js run     # or: yare run
```

See [`examples/kitchen-sink`](./examples/kitchen-sink) for a bigger tour:
recursion (`fib`), loops, `break`/`continue`, every primitive type, and a
browser demo (`index.html`) that loads the compiled `.wasm` directly.

## How a project is laid out

```
my-project/
  config.yare          # JSON project manifest (name, entry, libs, target)
  src/
    main.ys            # entry point
  .yarescript/         # build output (generated, gitignore this)
    my-project.wasm    # your compiled program
    loader.js          # tiny Node loader (zero app logic)
    loader.browser.js  # tiny browser loader (zero app logic)
```

`config.yare` is JSON, despite the extension — it's yarescript's answer to
`package.json`/`tsconfig.json`, and eventually the "libs" section is how
you'll pull in WebAssembly-compiled dependencies without any of it landing
in your loader as JavaScript.

## The language, briefly

Full grammar and semantics live in [`docs/LANGUAGE.md`](./docs/LANGUAGE.md).
The short version:

```
public function: int fib(int n) {
    if (n < 2) {
        return n;
    }
    return fib(n - 1) + fib(n - 2);
}

public function: void main() {
    let: int result = fib(10);
    console.log(result);

    const: double pi = 3.14159;

    for (let: int i = 0; i < 5; i++) {
        console.log(i);
    }
}
```

- Declarations read `let: TYPE name = value;` / `const: TYPE name = value;`
  — the type sits right after the colon, always.
- Functions read `visibility? function: RETURN_TYPE name(TYPE param, ...) { }`.
  `visibility` is `public` (exported from the compiled module) or
  `private` (internal only); it defaults to `public`.
- Every function and variable has an explicit type, from the low-level
  numerics (`int`, `long`, `float`, `double`) up through `bool` and
  `string` — no `any`, no implicit `undefined`.
- `main()` is required and is what `yare run` calls.

## Architecture

```
 .ys source
     │
     ▼
  lexer            src/lexer      — hand-written tokenizer
     │
     ▼
  parser           src/parser     — recursive-descent, produces an AST
     │
     ▼
  type checker      src/checker    — resolves every type, annotates the AST
     │
     ▼
  codegen           src/codegen    — walks the checked AST, emits WebAssembly
     │              via Binaryen
     ▼
 .wasm + loader.js  src/runtime    — the loader template (all the JS there is)
     │
     ▼
   CLI              src/cli        — `yare init|build|run`, config.yare
```

Everything is written from scratch in TypeScript for now (the compiler
itself, not your programs). It will be published to npm once the
language surface is stable — not yet.

## License

TBD.
