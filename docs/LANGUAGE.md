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
return value has an explicit type: one of the scalars below, an array of them
(`int[]`), or a struct you declared yourself. There is no inference on
declarations, and there is no `any`.

| Type     | WebAssembly representation       | Range and notes |
|----------|----------------------------------|-----------------|
| `void`   | (no value)                       | only valid as a function return type |
| `bool`   | `i32` (0 or 1)                   | |
| `i8`     | `i32`                            | 8-bit signed, `-128` to `127` |
| `i16`    | `i32`                            | 16-bit signed, `-32768` to `32767` |
| `char`   | `i32`                            | one 16-bit code unit, `0` to `65535`, printed as a letter |
| `int`    | `i32`                            | 32-bit signed |
| `long`   | `i64`                            | 64-bit signed |
| `u8`     | `i32`                            | 8-bit unsigned, `0` to `255` |
| `u16`    | `i32`                            | 16-bit unsigned, `0` to `65535` |
| `u32`    | `i32`                            | 32-bit unsigned, `0` to `4294967295` |
| `u64`    | `i64`                            | 64-bit unsigned |
| `float`  | `f32`                            | 32-bit float |
| `double` | `f64`                            | 64-bit float |
| `string` | `i32` pointer into linear memory | length-prefixed UTF-8: `[u32 length][bytes...]` |

The narrow types all live in a full WebAssembly register and are put back in
range on every write, so an `i8` holding 200 is not something that can happen
by accident.

### Families and widening

The numeric types come in three families, and widening only ever happens
inside one:

```
signed     i8 -> i16 -> char -> int -> long
unsigned   u8 -> u16 -> u32 -> u64
floating   float -> double
```

- Widening inside a family is implicit, in declarations, assignments, returns,
  and mixed arithmetic: `let: long big = 5;` and `1 + 2.5` both do the
  sensible thing.
- Any integer type widens to `float` or `double` implicitly, because that is
  the one conversion nobody ever wants to be told about.
- Narrowing never happens by accident. It needs an explicit cast: `x -> i8`.
- Signed and unsigned do not mix without a cast. `let: u16 a = 1; a + total`,
  where `total` is an `int`, is an error that tells you to cast one of them.
- Unsigned values compare unsigned, so `let: u32 big = 4000000000; big > 1`
  is true, which is the only correct answer for a `u32`.
- Narrow values wrap, because that is what their width means: `let: u8 a = 250;
  a = a + 10;` leaves 4 in `a`, and `let: i8 b = 100; b = b + 100;` leaves
  `-56` in `b`.

### Literals

A bare number is an `int`, or a `long` when it is too big for one. Where you
write it next to a narrower type it takes that type instead:

```
let: u8 mask = 200;          // fine, 200 fits in a u8
let: i8 low = -128;          // fine, and -128 is the smallest i8 there is
let: u8 tooBig = 256;        // error: 256 is out of range for 'u8' (it takes 0 to 255)

let: u8 i = 0;
i = i + 2;                   // the 2 borrows the u8, so this is u8 arithmetic
i = i + 300;                 // error: 300 is out of range for 'u8'
```

`console.println` has an overload for every type in the table, so any of them
can be printed as-is.

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

The type comes immediately after the colon, or it can be left off entirely
when the value on the right makes it obvious. `const` bindings must be
initialized at the declaration site and can never be reassigned (enforced by
the type checker, not just convention).

```
let: int x = 1;
const: string greeting = "hi";
let count = 0;          // int, from the 0
let ratio = 0.5;        // double
let label = "yare";     // string
let xs = new int[3];    // int[]
```

Inference is not guessing. It takes the type the checker already worked out
for the initializer and writes it into the declaration, so `let count = 0;`
and `let: int count = 0;` are the same variable as far as the rest of the
compiler is concerned. A `null` on its own has no type to offer, so
`let x = null;` is an error and `let: int[] x = null;` is not.

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
- `do { ... } while (cond);`, which runs the body once before asking
- `for (init; cond; update) { ... }`, where `init` may be a `let`/`const`
  declaration or an expression statement
- `for (let: TYPE name of xs) { ... }`, over the elements of an array or the
  chars of a string
- `for (let: int i in xs) { ... }`, over the indexes of an array or a string
- `switch (expr) { case v: ... default: ... }`
- `return expr;` / `return;`
- `break;` / `continue;` (inside a loop, or inside a `switch`)
- expression statements, e.g. a bare function call: `doSomething();`

`if`/`while`/`for`/`do` conditions must be `bool`. There is no truthiness
coercion from `int` or `string`.

Braces are optional around a single-statement body, so `if (ok) go();` is
legal. `yare fmt` puts the braces back.

A `switch` takes an integer, a `char`, a `string`, or a `bool`. Cases fall
through until a `break`, which is the behaviour you already know, and a
`break` inside a `switch` leaves the `switch` rather than the loop around it.
`of` and `in` are only special inside a `for` head; everywhere else they are
ordinary names.

```
public function: void main() {
    let: int[] xs = [4, 5, 6];
    let: int total = 0;
    for (let: int x of xs) {
        total += x;
    }
    for (let: int i in xs) {
        console.println(i);        // 0, 1, 2
    }
    let: string word = "";
    switch (total) {
        case 15: {
            word = "fifteen";
        }
        case 16: {
            word = word + " or sixteen";
            break;
        }
        default: {
            word = "something else";
        }
    }
    console.println(word);         // fifteen or sixteen
    let: int i = 0;
    do {
        i++;
    } while (i < 3);
}
```

## Expressions & operators

Arithmetic: `+ - * /` and `%` (integer types only; `%` on `float`/`double`
is a compile error, matching WebAssembly's numeric ops). Mixed-width
arithmetic widens the narrower operand, so `int * double` is a `double`.

Comparison: `== != < > <= >=`. `==`/`!=` work on numbers, `bool`, and
`string`; the ordering comparisons work on numeric types and on strings, where
they compare by code point. Arrays and structs do not compare at all, except
against `null`, which is how you ask whether a reference is empty. `===` and
`!==` are accepted as spellings of `==` and `!=`; nothing in yarescript
coerces, so there is no second meaning for them to carry.

Bitwise: `& | ^ << >>` and unary `~`, on integer types only. Shifts keep the
sign of a signed type and fill with zeroes for an unsigned one, which is what
`>>` means in each case. A `float` has no bits to move, so `1.5 & 1` is a
compile error rather than a surprise.

Conditional: `cond ? a : b`. The condition must be `bool`, the two arms have
to agree on a type (with the usual widening), and only the arm that was taken
is evaluated.

Logical: `&& ||` (both operands must be `bool`) and unary `!`. Both binary
logical operators short-circuit, so `i < s.length && s[i] == (97 -> char)`
never evaluates the index the first half just ruled out.

Assignment: `= += -= *= /= %= &= |= ^= <<= >>=`, and unary `++`/`--` (prefix
and postfix). The target can be a variable, an array slot, or a struct field,
so `xs[i] += 2` and `p.x++` work the way they look. `s += "more"` works on a
string, because building a string one piece at a time is not a crime. `const`
protects a variable from being reassigned and from being written through.

Member access: `s.length` and `xs.length` for a count, `p.field` for a struct
field, and `name(args)` for the dotted host functions such as
`console.println`.

Function calls: `name(args...)`. Calls are resolved to a user-defined
yarescript function, to a **host function** (see below), or to a struct name,
which builds one.

Template strings: a backtick string with `${...}` in it. Anything printable
goes inside the braces, which means text, a `char`, a `bool`, and every
numeric type. A `double` prints with up to six decimal places and no trailing
zeroes.

```
let: string name = "yare";
let: int n = 42;
console.println(`hi ${name}, ${n}, ${n / 2}, ${1.5}, ${true}`);
// hi yare, 42, 21, 1.5, true
```

`typeof expr` gives the type as a `string`, answered at compile time because
by then the type is a fact: `typeof 1` is `"int"` and `typeof xs` is
`"int[]"`.

`null` is a value for the three kinds of reference there are: an array, a
struct, and a string. It fits nowhere else, it has to be given a type by
something around it, and it compares with `==` and `!=`. Reading through a
null traps, the way reading past the end of an array does.

## Strings

`+` concatenates, `==` / `!=` compare by content rather than by pointer, `s[i]`
reads one `char` (bounds checked, so an out-of-range index traps instead of
reading your neighbour's bytes), and `s.length` is the number of bytes:

```
public function: void main() {
    let: string name = "yare" + "script";
    console.println(name);            // yarescript
    console.println(name == "yarescript");  // true
    console.println(("ab" + "c") == ("a" + "bc"));  // true
}
```

Concatenation allocates from a bump allocator in linear memory, and the
module grows its memory as needed. There is no garbage collector yet, so a
program that builds strings in a long loop keeps every intermediate result
alive. A `char` concatenates onto a string from either side, so `"a" + c` and `c + "a"`
both work. Writing into one is a compile error: `s[0] = (89 -> char)` reads
better than it behaves, because other code may be holding a pointer to those
bytes. Build a new string instead.

Strings also order with `<`, `>`, `<=`, and `>=`. The order is byte order,
which for UTF-8 is also code point order: `"Z" < "a"` is true and `"apple" <
"apples"` is true because it is shorter. It is not a locale collation and it
does not pretend to be one.

## Arrays

```
TYPE[] NAME
```

An array is a length followed by that many slots of one type. You build one
from a literal or with a size, index it with `[i]`, and measure it with
`.length`:

```
let: int[] xs = [10, 20, 30];
console.println(xs.length);      // 3
console.println(xs[0]);          // 10
xs[1] = 99;
xs[1]++;                         // slots take ++ and += like variables do

let: int[] zeros = new int[5];   // zero filled, size can be a variable
let: u8[] bytes = new u8[256];   // one byte each: a real byte array
let: string[] names = ["ada", "grace"];
let: int[][] grid = [[1, 2], [3, 4]];
```

- An element type can be anything, including another array or a struct.
- Indexing is bounds checked. Out of range traps rather than reading whatever
  happens to be next door.
- An array literal takes its type from where it is going: `let: int[] xs =
  [1, 2, 3];` and `total([1, 2, 3])` both work, while a bare `[1, 2]` with
  nothing to aim at is an error.
- Arrays are invariant. An `int[]` is not a `double[]`, and widening does not
  reach inside them.
- Two arrays are never `==`, even with the same contents. They are two arrays.
- There is no garbage collector yet, so an array you stop pointing at keeps
  its memory until the module is done.

## Structs

```
struct NAME {
    TYPE field;
    ...
}
```

A struct is a fixed-layout record you declare at the top level and build like
a function call, with the fields in the order you wrote them:

```
struct Point {
    int x;
    int y;
}

public function: int manhattan(Point p) {
    return p.x + p.y;
}

public function: void main() {
    let: Point p = Point(3, 4);
    console.println(p.x);       // 3
    p.x = 10;
    p.y++;
    console.println(manhattan(p));
}
```

- Fields can be any type, including arrays and other structs.
- Fields are laid out in declaration order at their natural alignment, and the
  layout is worked out once by the type checker, so what you read is what was
  stored.
- A struct variable holds a pointer to the record. Assigning one to another
  shares it rather than copying it, and so does putting it in another struct.
- A struct may refer to itself, because what it holds is a pointer: `struct
  XmlNode { XmlNode[] children; }` is how a document tree is written.
- Structs are not numbers: they do not compare with `==`, do not take `+`, and
  do not cast.

## The standard surface: host functions

These are available without any import.

- `console.println(x)` for every type that holds a value: all thirteen of them.
  The type checker resolves the call to a type-specific WebAssembly host import
  (`console_println_string`, `console_println_bool`, `console_println_char`,
  `console_println_int`, `console_println_uint`, `console_println_long`,
  `console_println_ulong`, `console_println_float`, `console_println_double`) and
  the generated loader supplies the implementation. `char` prints as a letter,
  and the unsigned printers print unsigned, so a `u32` holding `4294967295`
  does not come out looking negative. Arrays and structs have no printer; walk
  them and print what is inside.
- `assert(cond: bool)` does nothing when `cond` is true and traps the module
  when it is false. This is how tests fail.

This is intentional: the compiled `.wasm` never talks to the host through
ad hoc JS glue code your program authored. It goes through a small,
fixed set of well-known imports the loader always provides.

## Standard library modules

```
@modules.import("str");
```

A directive is an instruction to the build rather than to the program, and it
sits at the top level with the imports. The bundled modules are `str`, `math`,
`json`, `toml`, and `xml`; the list is whatever is in the compiler's
`stdlib/` directory.

Once imported, a module's functions are called with the module name in front:

```
@modules.import("str");
@modules.import("math");

public function: void main() {
    console.println(str.upper("yare"));   // YARE
    console.println(str.reverse("abc"));  // cba
    console.println(math.pow(2, 10));     // 1024
    console.println(math.sqrt(144.0));    // 12
}
```

Only the functions you actually call are linked into your module, and a call to
one module function that calls another pulls the second one in too. Import a
module and never use it and it costs you nothing. Unknown modules and unknown
functions are reported with a suggestion.

### Documents

Three of those modules read documents. Each hands you a struct tree, each
answers `ok` and `errorOf` about what it was given, and none of them traps on
input they do not like.

```
@modules.import("json");
@modules.import("toml");
@modules.import("xml");

public function: void main() {
    let: JsonValue doc = json.parse("{\"n\":42,\"tags\":[\"a\",\"b\"]}");
    console.println(json.intOf(json.find(doc, "n")));            // 42
    console.println(json.count(json.find(doc, "tags")));         // 2
    console.println(json.stringify(doc));   // {"n":42,"tags":["a","b"]}

    let: TomlDoc config = toml.parse("[server]\nport = 8080\n");
    console.println(toml.intOf(config, "server", "port"));       // 8080

    let: XmlDoc note = xml.parse("<note priority=\"1\"><to>Tove</to></note>");
    console.println(xml.attr(xml.root(note), "priority"));       // 1
    console.println(xml.textOf(xml.find(xml.root(note), "to")));  // Tove
}
```

`json` kinds are object, array, string, number, bool, null, and error, and
`kindName` spells them out. `toml` keeps entries flat with the section each one
came from, and `has` tells you whether a key is there before you read it.
`xml` skips prologs and comments, keeps attributes in order, and turns a run of
text into a text node.

Struct names carry the module in front of them (`JsonValue`, `TomlDoc`,
`XmlNode`) because two modules that both declared `Doc` would collide once
linked into one WebAssembly module.

Not covered yet: unicode escapes and entity decoding, toml inline tables and
array values, and xml namespaces.

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

## Errors

Every "I have never heard of this" error comes with the closest thing the
compiler has heard of, when there is one close enough to be worth mentioning:

```
error: Unknown function 'prntln'. Did you mean 'console.println'? (line 1)
error: Unknown identifier 'totl'. Did you mean 'total'? (line 2)
error: Unknown type 'integ'. Did you mean 'int'? (line 1)
error: Module 'str' has no function 'uppr'. Did you mean 'upper'?
```

Names from other languages get a signpost too: `console.log`, `println`,
`print`, and `log` all point at `console.println`, and `number` points at
`double`.

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
    console.println("yarescript kitchen sink");
    console.println(fib(10));
    console.println(sumTo(100));
    console.println(isEven(sumTo(100)));
}
```
