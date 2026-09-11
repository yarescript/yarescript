# The yarescript language

This document specifies the syntax and semantics currently implemented by
the compiler in this repo (`src/lexer`, `src/parser`, `src/checker`,
`src/codegen`). Anything marked **(planned)** is not implemented yet. See
[ROADMAP.md](../ROADMAP.md).

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
return value has an explicit primitive type. There is no inference on
declarations, and there is no `any`.

| Type     | WebAssembly representation                     | Notes |
|----------|-------------------------------------------------|-------|
| `void`   | (no value)                                      | only valid as a function return type |
| `bool`   | `i32` (0 or 1)                                  | |
| `char`   | `i32`                                           | one code unit, printed as a letter |
| `int`    | `i32`                                           | 32-bit signed integer |
| `long`   | `i64`                                           | 64-bit signed integer |
| `float`  | `f32`                                           | 32-bit float |
| `double` | `f64`                                           | 64-bit float |
| `string` | `i32` pointer into linear memory                | length-prefixed UTF-8: `[u32 length][bytes...]` |

Numeric types widen implicitly in one direction only:
`char -> int -> long -> float -> double`. Widening happens on its own in
declarations, assignments, returns, and mixed arithmetic, so `let: double x = 1;`
and `1 + 2.5` both do the sensible thing.

Narrowing never happens by accident. It needs an explicit cast.

## Casts

```
expr -> TYPE
```

```
let: double pi = 3.99;
let: int n = pi -> int;        // 3, truncated toward zero
let: long big = pi -> long;    // 3
let: bool yes = 7 -> bool;     // true, because nonzero
let: char letter = 72 -> char; // printed as "H"
```

The arrow binds tighter than arithmetic, so `2.5 + 1 -> int` means
`2.5 + (1 -> int)` and prints `3.5`. Put parens around the whole expression
when you want `(2.5 + 1) -> int`.

Casts work between numeric types and between `bool` and the integers. Casting
to or from `string` is a compile error: a string is a pointer plus a length,
not a number.

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

An integer literal too wide for `int` becomes a `long` automatically, so
`let: long big = 3000000000;` works and `let: int big = 3000000000;` is a
type error rather than a silent wraparound.

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
- `export` is accepted as a friendlier spelling of `public`. They are the
  same thing.
- A non-`void` function must return a value of its declared type (or an
  implicitly-widenable one) on **every** control-flow path; the checker
  verifies this statically and refuses to compile otherwise.
- Every program needs exactly one `public function: void main()` (or any
  return type, though `void` is idiomatic). This is the entry point
  `yare run` invokes.
- Function names starting with `__yare_` are reserved for the runtime, which
  uses that prefix for the helpers behind string operators.

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
- `for (init; cond; update) { ... }`, where `init` may be a `let`/`const`
  declaration or an expression statement
- `return expr;` / `return;`
- `break;` / `continue;` (only valid inside a loop)
- expression statements, e.g. a bare function call: `doSomething();`

`if`/`while`/`for` conditions must be `bool`. There is no truthiness
coercion from `int` or `string`.

## Expressions & operators

Arithmetic: `+ - * /` and `%` (integer types only; `%` on `float`/`double`
is a compile error, matching WebAssembly's numeric ops). Mixed-width
arithmetic widens the narrower operand, so `int * double` is a `double`.

Comparison: `== != < > <= >=`. `==`/`!=` work on numbers, `bool`, and
`string`; the ordering comparisons only work on numeric types.

Logical: `&& ||` (both operands must be `bool`) and unary `!`.

Assignment: `= += -= *= /=`, and unary `++`/`--` (prefix and postfix),
all on plain variables today.

Function calls: `name(args...)`. Calls are resolved either to a
user-defined yarescript function or to a **host function** (see below).

## Strings

`+` concatenates and `==` / `!=` compare by content, not by pointer:

```
public function: void main() {
    let: string name = "yare" + "script";
    console.log(name);            // yarescript
    console.log(name == "yarescript");  // true
    console.log(("ab" + "c") == ("a" + "bc"));  // true
}
```

Concatenation allocates from a bump allocator in linear memory, and the
module grows its memory as needed. There is no garbage collector yet, so a
program that builds strings in a long loop keeps every intermediate result
alive. Ordering comparisons (`<`, `>` and friends) on strings are a compile
error for now.

## The standard surface: host functions

These are available without any import.

- `console.log(x)` for every primitive type. The type checker resolves the
  call to a type-specific WebAssembly host import (`console_log_string`,
  `console_log_int`, `console_log_long`, `console_log_float`,
  `console_log_double`, `console_log_bool`, `console_log_char`) and the
  generated loader supplies the implementation. `char` prints as a letter.
- `assert(cond: bool)` does nothing when `cond` is true and traps the module
  when it is false. This is how tests fail.

This is intentional: the compiled `.wasm` never talks to the host through
ad hoc JS glue code your program authored. It goes through a small,
fixed set of well-known imports the loader always provides.

## Modules & imports

```
import { helper } from "./helper.ys";
```

Imports resolve relative to the file that writes them, and `.ys` is optional
(`"./helper"` and `"./helper.ys"` are the same file). The build pulls every
imported file into one module, so a `public` function in `helper.ys` is
callable from your entry file and exported from the final `.wasm`.

- Importing a name the target file does not declare is a compile error.
- A circular import is reported with the chain that caused it.
- A file imported by two different files is compiled once.
- A file with no `main` is fine, as long as something in the build has one.

## Tests

`yare test` runs every `public` function whose name starts with `test`, in
every `*.test.ys` file in the project. A test passes by returning normally
and fails by trapping, which is what `assert(false)` does.

```
import { square } from "../src/math.ys";

public function: void test_square() {
    assert(square(6) == 36);
}
```

Test files do not need a `main`.

## Formatting

`yare fmt` rewrites every `.ys` file in the project into the canonical
layout: four-space indents, spaces around operators, one statement per line.
Your comments and the blank lines between statements survive, and formatting
twice changes nothing. `yare fmt --check` reports what would change and exits
nonzero, which is the version you want in CI.

Formatting never changes what your program means. Parentheses that the parser
discards are put back wherever precedence needs them, so `(a + b) / two` does
not quietly turn into `a + b / two`.

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
