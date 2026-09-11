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
functions such as `console.log`. Your actual program, every `if`, every loop,
every function, is real WebAssembly bytecode running at near-native speed.

```
public function: void main() {
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
- Static type checker (`int`, `long`, `float`, `double`, `bool`, `string`,
  `void`)
- Binaryen-backed codegen emitting real, runnable `.wasm`
- Functions, `let`/`const`, `if`/`else`, `while`, `for`, `break`, `continue`,
  recursion, operator precedence
- `console.log` as a host import, overloaded per type, which proves yarescript
  can talk to the outside world without becoming JavaScript
- `yare init` / `yare build` / `yare run` CLI
- `config.yare` project manifest
- A small generated loader for both Node and the browser

Still to come:

- String operators (`+`, `==`), arrays and objects, a real module/import system,
  and a package registry for "libs". See [ROADMAP.md](./ROADMAP.md).
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
    console.log(result);

    const: double pi = 3.14159;

    for (let: int i = 0; i < 5; i++) {
        console.log(i);
    }
}
```

- Declarations read `let: TYPE name = value;` and `const: TYPE name = value;`.
  The type always sits right after the colon.
- Functions read `visibility? function: RETURN_TYPE name(TYPE param, ...) { }`.
  `visibility` is `public` (exported from the compiled module) or `private`
  (internal only), and it defaults to `public`.
- Every function and variable has an explicit type, from the low-level numerics
  (`int`, `long`, `float`, `double`) up through `bool` and `string`. There is no
  `any` and no implicit `undefined`.
- `main()` is required, and it is what `yare run` calls.

## Architecture

```
 .ys source
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

TBD.
