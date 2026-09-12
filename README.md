# yarescript

**A compiled language for the web. Your code becomes WebAssembly, not JavaScript.**

`yare` is an old English word for quick, nimble, and ready, which is where the
name comes from. The language is yarescript. The compiler is `yare`.

TypeScript compiles down to JavaScript. You get a type-checked front layer
bolted onto the same runtime, the same footguns, and the same "well, technically
it is still JS at 3am in production" problems. yarescript does not do that. It
compiles straight to **WebAssembly**. There is no JavaScript application layer.
The only JavaScript yarescript produces is a small, fixed-size loader that
instantiates your compiled `.wasm` module and wires up a handful of host
functions such as `console.println`. Your actual program, every `if`, every loop,
every function, is real WebAssembly bytecode running at near-native speed.

```
public function: void main() {  // I didnt use, int becuase I am lazy
    console.println("hello, world");
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

## The language and its compilers

yarescript is the language, and it is open source. So is `yare`, the first
compiler for it, written in TypeScript and living in this repo.

Because the language is open, `yare` does not have to be the only way to build a
yarescript program. C had `cc`, and then `gcc` and `clang` came along and gave
everyone a choice. yarescript is set up for the same story. If you want to write
your own yarescript compiler, in Rust, Go, Zig, or plain C, implement the
language as specified in [`docs/LANGUAGE.md`](./docs/LANGUAGE.md) and you have a
yarescript compiler. `yare` is the reference implementation you can compare your
output against.

## Why

- **TypeScript fixes the types, not the runtime.** You still ship JavaScript.
  With yarescript you ship WebAssembly, and JavaScript only ever shows up as the
  loader.
- **Fast at runtime, even when compiling takes a moment.** yarescript leans on
  [Binaryen](https://github.com/WebAssembly/binaryen) to emit optimized
  WebAssembly. Compiling can take a moment. Running your program should not.
- **A tiny, fixed-size loader instead of a bundle that grows with your app.**
  `.yarescript/loader.js` never changes shape. It loads whatever `.wasm` and
  libraries your program needs, and it does not contain your program.
- **Built from scratch.** The language, its type system, and its runtime model
  are yarescript's own design. This is not a fork of AssemblyScript, and it is
  not TypeScript with a few parts removed.

## Status

Early, but real. The `.ys` to WebAssembly pipeline works end to end today.

Working right now:

- Lexer, recursive-descent parser, and AST
- A static type checker with the whole numeric ladder: `i8`, `i16`, `char`,
  `int`, `long`, `u8`, `u16`, `u32`, `u64`, `float`, `double`, plus `bool`,
  `string`, and `void`
- Binaryen-backed codegen emitting real, runnable `.wasm`
- Functions, `let`/`const`, `if`/`else`, `while`, `for`, `break`, `continue`,
  recursion, operator precedence
- Strings you can concatenate and compare, index with `s[i]`, and measure with
  `s.length`, on a small allocator that grows the module when it runs out of
  room
- A standard library you import with `@modules.import("str")`, linked function
  by function into `.yare/dep/build/*.yare.dep`
- Explicit casts with `->`, so narrowing a number is something you choose
- Cross-file modules: `import { helper } from "./helper.ys"`
- `console.println` and `assert` as host imports, which proves yarescript can talk
  to the outside world without becoming JavaScript
- `yare init` / `yare build` / `yare run` / `yare fmt` / `yare test` CLI
- Error messages that suggest what you meant: `prntln` gets pointed at
  `console.println`, `totl` at `total`, `integ` at `int`
- `config.yare` project manifest
- A small generated loader for both Node and the browser

Still to come:

- Arrays, structs, generics, a garbage collector, source maps, an editor
  extension, and a package registry for "libs". See [ROADMAP.md](./ROADMAP.md).
- yarescript is not published to npm yet, so this is pre-release. When it ships,
  you will be able to install it with `npm install -g yarescript`.

## Quick start (from a checkout of this repo)

```bash
npm install
npm run build        # compiles the yarescript compiler itself (TS -> dist/)

cd examples/hello-world
node ../../dist/cli/index.js build   # or, once installed: yare build
node ../../dist/cli/index.js run     # or: yare run
```

Then try the other commands from inside a project:

```bash
node ../../dist/cli/index.js test          # runs every *.test.ys file
node ../../dist/cli/index.js fmt --check   # reports what needs reformatting
```

See [`examples/kitchen-sink`](./examples/kitchen-sink) for a bigger tour:
recursion (`fib`), loops, `break`/`continue`, every primitive type, and a
browser demo (`index.html`) that loads the compiled `.wasm` directly.
[`examples/modules`](./examples/modules) shows a two-file project with imports
and a test file.

## How a project is laid out

```
my-project/
  config.yare          # JSON project manifest (name, entry, libs, target)
  src/
    main.ys            # entry point
  .yare/               # build output (generated, gitignore this)
    config-lock.yare   # what was linked, and the hash it came from
    my-project.wasm    # your compiled program
    loader.js          # tiny Node loader (zero app logic)
    loader.browser.js  # tiny browser loader (zero app logic)
    dep/
      build/
        str.yare.dep   # a compiled module: an object file, for wasm
```

## Modules and .yare.dep files

The bundled modules live in [`stdlib/`](./stdlib) and you pull them in with a
directive:

```
@modules.import("str");
@modules.import("math");

public function: void main() {
    console.println(str.upper("yarescript"));
    console.println(math.sqrt(144.0));
}
```

`yare build` compiles each module into `.yare/dep/build/<name>.yare.dep`, which
is an object file for WebAssembly: a function index, a source hash, and the
pieces the linker needs. Then it links **only what you called**.

```
$ yare build
Compiled src/main.ys -> .yare/stdlib.wasm
Module:   str 0.1.0 (2 of 7 functions linked)
Module:   math 0.1.0 (2 of 5 functions linked)
Lock:     .yare/config-lock.yare
Exports:  main
```

Import `json` and never call it, and none of it lands in your binary. Call one
function that calls another and both come along, because the linker follows the
calls. `config-lock.yare` records exactly which functions went in, with the hash
of the module they came from, so a build can be reproduced later.

`config.yare` is JSON, despite the extension. It is yarescript's answer to
`package.json` and `tsconfig.json`, and the `libs` section in it is how you will
pull in WebAssembly-compiled dependencies without any of that landing in your
loader as JavaScript.

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
    console.println(result);

    const: double pi = 3.14159;

    for (let: int i = 0; i < 5; i++) {
        console.println(i);
    }
}
```

- Declarations read `let: TYPE name = value;` and `const: TYPE name = value;`.
  The type always sits right after the colon.
- Functions read `visibility? function: RETURN_TYPE name(TYPE param, ...) { }`.
  `visibility` is `public` (exported from the compiled module) or `private`
  (internal only), and it defaults to `public`.
- Every function and variable has an explicit type, from the low-level numerics
  (`i8`, `u8`, `char`, `int`, `long`, `u32`, `u64`, `float`, `double`) up
  through `bool` and `string`. There is no `any` and no implicit `undefined`.
- Numbers widen on their own and narrow only when you ask: `let: int n = pi -> int;`
  Signed and unsigned never mix without a cast, and a narrow value wraps the
  way its width says it should.
- Strings concatenate with `+` and compare with `==`, and you can index them:
  `s[0]` is a `char` and `s.length` is an `int`.
- Other files come in with `import { helper } from "./helper.ys";`
- `main()` is required, and it is what `yare run` calls.

## Architecture

```
 .ys source (and every file it imports, resolved by src/modules)
     |
     v
  lexer          src/lexer      hand-written tokenizer
     |
     v
  parser         src/parser     recursive descent, produces an AST
     |
     v
  type checker   src/checker    resolves every type, annotates the AST
     |
     v
  codegen        src/codegen    walks the checked AST, emits WebAssembly
                                through Binaryen
     |
     v
 .wasm + loader  src/runtime    the loader template, which is all the
                                JavaScript there is
     |
     v
  CLI            src/cli        yare init|build|run, config.yare
                                plus yare fmt (src/fmt) and
                                yare test (src/test-runner)
```

The compiler itself is written from scratch in TypeScript for now. Your
programs are not, they compile to WebAssembly. yarescript will be published to
npm once the language surface is stable.

## Made by

yarescript is built and maintained by two people.

- [Seigh-sword](https://github.com/Seigh-sword) (Arunkumar) writes the code and
  fixes the bugs.
- [suripewepedie](https://github.com/suripewepedie) (Surya) handles
  maintenance. He watches for errors, tests the builds and examples, and makes
  sure everything actually works before it reaches you.

Hit a compiler bug or a crash? Open an issue and Seigh-sword will take a look.
Something failing in a release, an example, or the docs? That lands with Surya.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
