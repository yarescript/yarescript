# Roadmap

The yarescript compiler pipeline (`.ys` -> tokens -> AST -> type-checked AST ->
WebAssembly through Binaryen) is real and working today for a meaningful subset
of the language. This is what comes next, roughly in the order you should expect
it to land.

## Recently landed

These used to be on this list and are now in the compiler, documented in
[docs/LANGUAGE.md](./docs/LANGUAGE.md) and covered by tests:

- String `+`, `==`, and `!=` in codegen, on a bump allocator in linear memory
  that grows the module as needed.
- Cross-file modules: `import { x } from "./file.ys"` is resolved, checked, and
  linked into one module, with cycles and missing names reported.
- Explicit narrowing casts with `->`, so truncation is opt-in and visible.
- `yare fmt`, an opinionated formatter that keeps your comments and your
  parentheses.
- `yare test`, a runner for `*.test.ys` files, plus an `assert` host function
  for failing on purpose.
- `char`, `export` as a spelling of `public`, `assert`, and integer literals
  wide enough to become `long` on their own.
- String indexing (`s[i]`) and `s.length`, both bounds checked, plus `char`
  concatenation from either side.
- A standard library you import with `@modules.import("str")`, shipped as
  yarescript source and linked function by function.
- `.yare/` build output with `config-lock.yare` and `dep/build/*.yare.dep`
  object files. Import a module you never call and none of it is linked.
- Error messages that suggest the name you were reaching for.
- Apache License 2.0.

## Near-term (language completeness)

- [ ] The rest of the numeric ladder: `u8`, `u16`, `u32`, `u64`, `i8`, and
      `i16`. `char`, `int`, `long`, `float`, and `double` are here; the narrow
      and unsigned widths are not, and "every type from low level to high
      level" is not true until they are.
- [ ] Arrays (`int[]`, `string[]`, ...) and a fixed-size struct/record
      type for "high level" data, not just scalars.
- [ ] Real json, xml, and toml documents. The `json` module can build json
      today (`ofInt`, `ofBool`, `quote`). Reading a document back needs a value
      type that can hold "a number or a list or a map", which means structs
      first. That is the blocker, and it is the only one.
- [ ] `struct`/custom types, and eventually a minimal generics story.
- [ ] Ordering comparisons on strings, once there is a collation answer
      worth defending.
- [ ] Member access on real values (`point.x`, `items.length`), which today
      only exists as the `console.log` call path.
- [ ] Compound assignment and `++`/`--` on anything other than a plain
      variable.

## Tooling

- [ ] Source maps from `.wasm` back to `.ys` so you can debug your own code
      instead of reading WebAssembly text.
- [ ] Editor extension: syntax highlighting plus the error messages the
      checker already produces.
- [ ] `libs` resolution in `config.yare`: a real dependency story for
      pulling in precompiled WebAssembly packages. This is where the idea
      of shipping big libraries as wasm instead of JavaScript actually
      gets implemented. It will likely sit on an npm-backed registry
      under the hood, but you consume it through `yare`, not
      `npm install`.
- [ ] `yare check`, for type-checking without emitting anything.

## Runtime

- [ ] A real allocator. Strings currently come from a bump allocator with no
      collector, so a loop that concatenates keeps every intermediate string
      alive. This is the first thing that will hurt a real program.
- [ ] Expand the host-function surface beyond `console.log` and `assert`
      (timers, fetch/network, DOM interop for browser targets) while keeping
      the loader generation logic table-driven and tiny.
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
