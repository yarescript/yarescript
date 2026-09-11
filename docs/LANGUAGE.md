# The yarescript language

This document specifies the syntax and semantics currently implemented by
the compiler in this repo (`src/lexer`, `src/parser`, `src/checker`,
`src/codegen`). Anything marked **(planned)** is not implemented yet — see
[ROADMAP.md](./../ROADMAP.md).

## File extension

Source files use `.ys`. A project's entry point is declared in
`config.yare` (`entry`, e.g. `"src/main.ys"`).

## Comments

```
// line comment
/* block
   comment */
```

## Types

yarescript is statically typed. Every variable, parameter, and function
return value has an explicit primitive type — there is no inference on
declarations and no `any`.

| Type     | WebAssembly representation                     | Notes |
|----------|-------------------------------------------------|-------|
| `void`   | (no value)                                      | only valid as a function return type |
| `bool`   | `i32` (0 or 1)                                  | |
| `int`    | `i32`                                           | 32-bit signed integer |
| `long`   | `i64`                                           | 64-bit signed integer |
| `float`  | `f32`                                           | 32-bit float |
| `double` | `f64`                                           | 64-bit float |
| `string` | `i32` pointer into linear memory                | length-prefixed UTF-8: `[u32 length][bytes...]` |

Numeric types widen implicitly in one direction only:
`int -> long -> float -> double`. Narrowing requires an explicit cast
**(planned)** — right now, narrowing assignments are a type error.

## Declarations

```
let: TYPE name = expr;      // mutable
const: TYPE name = expr;    // immutable, must be initialized
```

The type always comes immediately after the colon. `const` bindings must
be initialized at the declaration site and can never be reassigned
(enforced by the type checker, not just convention).

```
let: int x = 1;
const: string greeting = "hi";
```

## Functions

```
visibility? function: RETURN_TYPE name(PARAM_TYPE paramName, ...) {
    ...
}
```

- `visibility` is `public` or `private`. Omitting it defaults to
  `public`. `public` functions are exported from the compiled WebAssembly
  module (callable from the host loader or other WebAssembly modules);
  `private` functions exist only inside the module.
- A non-`void` function must return a value of its declared type (or an
  implicitly-widenable one) on **every** control-flow path; the checker
  verifies this statically and refuses to compile otherwise.
- Every program needs exactly one `public function: void main()` (or any
  return type, though `void` is idiomatic) — this is the entry point
  `yare run` invokes.

```
public function: int add(int a, int b) {
    return a + b;
}

private function: int square(int x) {
    return x * x;
}
```

## Statements

- `if (cond) { ... } else if (cond) { ... } else { ... }`
- `while (cond) { ... }`
- `for (init; cond; update) { ... }` — `init` may be a `let`/`const`
  declaration or an expression statement
- `return expr;` / `return;`
- `break;` / `continue;` (only valid inside a loop)
- expression statements, e.g. a bare function call: `doSomething();`

`if`/`while`/`for` conditions must be `bool` — there is no truthiness
coercion from `int` or `string`.

## Expressions & operators

Arithmetic: `+ - * /` and `%` (integer/long only; `%` on `float`/`double`
is a compile error, matching WebAssembly's numeric ops).

Comparison: `== != < > <= >=`. `==`/`!=` work on numbers, `bool`, and
`string`; the ordering comparisons only work on numeric types.

Logical: `&& ||` (both operands must be `bool`) and unary `!`.

Assignment: `= += -= *= /=`, and unary `++`/`--` (prefix and postfix),
all on plain variables today.

String concatenation with `+` on two `string` operands is **planned**
(not implemented in codegen yet — see ROADMAP).

Function calls: `name(args...)`. Calls are resolved either to a
user-defined yarescript function or to a **host function** (see below).

## The standard surface: host functions

`console.log(x)` is available without any import, for every primitive
type. The type checker resolves the call to a type-specific WebAssembly
host import (`console_log_string`, `console_log_int`, `console_log_long`,
`console_log_float`, `console_log_double`, `console_log_bool`) and the
generated loader supplies the actual implementation. This is
intentional: the compiled `.wasm` never talks to the host through
ad hoc JS glue code your program authored — it goes through a small,
fixed set of well-known imports the loader always provides.

## Modules & imports **(planned)**

```
import { helper } from "./helper.ys";
```

The parser accepts this syntax today; the checker/codegen do not resolve
cross-file imports yet. Multi-file programs and the `libs` section of
`config.yare` (for pulling in precompiled WebAssembly dependencies) are
tracked in the roadmap.

## Example: everything at once

```
public function: int fib(int n) {
    if (n < 2) {
        return n;
    }
    return fib(n - 1) + fib(n - 2);
}

public function: int sumTo(int n) {
    let: int total = 0;
    for (let: int i = 1; i <= n; i++) {
        total += i;
    }
    return total;
}

public function: bool isEven(int n) {
    return n % 2 == 0;
}

public function: void main() {
    console.log("yarescript kitchen sink");
    console.log(fib(10));
    console.log(sumTo(100));
    console.log(isEven(sumTo(100)));
}
```
