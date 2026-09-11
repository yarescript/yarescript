# Roadmap

The yarescript compiler pipeline (`.ys` -> tokens -> AST -> type-checked AST ->
WebAssembly through Binaryen) is real and working today for a meaningful subset
of the language. This is what comes next, roughly in the order you should expect
it to land.

## Near-term (language completeness)

- [ ] String operators in codegen: `+` (concatenation) and `==`/`!=`
      (byte comparison) currently type-check but throw at codegen time.
      Needs a tiny runtime allocator in linear memory.
- [ ] Arrays (`int[]`, `string[]`, ...) and a fixed-size struct/record
      type for "high level" data, not just scalars.
- [ ] Real cross-file modules: resolve `import { x } from "./file.ys"`
      into a linked multi-module build instead of parsing-but-ignoring it.
- [ ] Explicit narrowing casts (e.g. `double -> int`) instead of a hard
      type error, so truncation is opt-in and visible.
- [ ] `struct`/custom types, and eventually a minimal generics story.

## Tooling

- [ ] `yare fmt`, an opinionated formatter.
- [ ] `yare test`, a test runner for `.ys` unit tests.
- [ ] Source maps from `.wasm` back to `.ys` so you can debug your own code.
- [ ] VS Code extension: syntax highlighting plus the error messages the
      checker already produces.
- [ ] `libs` resolution in `config.yare`: a real dependency story for
      pulling in precompiled WebAssembly packages. This is where the idea
      of shipping big libraries as wasm instead of JavaScript actually
      gets implemented. It will likely sit on an npm-backed registry
      under the hood, but you consume it through `yare`, not
      `npm install`.

## Runtime

- [ ] Expand the host-function surface beyond `console.log` (timers,
      fetch/network, DOM interop for browser targets) while keeping the
      loader generation logic table-driven and tiny.
- [ ] A garbage collector / arena allocator for strings & arrays, so
      your programs are not limited to compile-time-known memory.
- [ ] WASI target for standalone/server-side execution outside Node.

## Distribution

- [ ] Publish `yarescript` to npm once `init`/`build`/`run` and the type
      system are stable enough to not break on you every week. Not yet,
      see the "Status" section in the README.
- [ ] Semantic versioning policy for the `"target"` field in `config.yare`
      as more compile targets (if any) get added.

## Writing your own yarescript compiler

yarescript is open source, so `yare` is only the first implementation of the
language. If you are building your own compiler, the checklist looks roughly
like this:

- [ ] A published, stable language spec you can code against
      ([docs/LANGUAGE.md](./docs/LANGUAGE.md) today).
- [ ] A shared conformance suite of `.ys` programs and expected output, so your
      compiler and `yare` can be checked against each other.
- [ ] An agreed WebAssembly ABI for host functions and string layout, so a
      module built by one compiler can be loaded by any loader.

## Explicitly out of scope for v1

- Compiling *to* JavaScript, ever, for anything other than the fixed-size
  loader. That is the entire point.
