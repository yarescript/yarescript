# Roadmap

yarescript's compiler pipeline (`.ys` → tokens → AST → type-checked AST →
WebAssembly via Binaryen) is real and working today for a meaningful
subset of the language. This is the honest list of what's next, roughly
in the order it should land.

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

- [ ] `yare fmt` — opinionated formatter.
- [ ] `yare test` — a test runner for `.ys` unit tests.
- [ ] Source maps from `.wasm` back to `.ys` for debugging.
- [ ] VS Code extension: syntax highlighting + the error messages the
      checker already produces.
- [ ] `libs` resolution in `config.yare`: a real dependency story for
      pulling in precompiled WebAssembly packages (this is where "we ship
      massive libs as wasm, not JS" gets implemented) — likely an
      npm-backed registry under the hood, but consumed by `yare`, not
      `npm install`.

## Runtime

- [ ] Expand the host-function surface beyond `console.log` (timers,
      fetch/network, DOM interop for browser targets) while keeping the
      loader generation logic table-driven and tiny.
- [ ] A garbage collector / arena allocator for strings & arrays, so
      programs aren't limited to compile-time-known memory.
- [ ] WASI target for standalone/server-side execution outside Node.

## Distribution

- [ ] Publish `yarescript` to npm once `init`/`build`/`run` and the type
      system are stable enough to not break every week. Not yet — see
      README "Status".
- [ ] Semantic versioning policy for `config.yare`'s `"target"` field as
      more compile targets (if any) get added.

## Explicitly out of scope for v1

- Compiling *to* JavaScript, ever, for anything other than the fixed-size
  loader. That's the entire point.
