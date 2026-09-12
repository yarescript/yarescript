import { tokenize } from "../lexer/lexer";
import { Token, TokenType } from "../lexer/tokens";
import { Parser } from "../parser/parser";
import * as N from "../ast/nodes";

const INDENT = "    ";

// Operator precedence, matching the parser exactly. A formatter that gets
// these wrong does not reformat your program, it replaces it with a different
// one that looks similar. See `sub()`.
const PREC: Record<string, number> = {
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};
const PREC_ASSIGN = 1;
const PREC_PREFIX = 8;
const PREC_POSTFIX = 9;
const PREC_ATOM = 10;

/**
 * Reformats yarescript source into the one true layout: four-space indents,
 * spaces around operators, one statement per line.
 *
 * Two promises it tries hard to keep:
 *
 * 1. Your program means exactly the same thing afterwards. Parentheses that
 *    the parser threw away are put back wherever precedence needs them, so
 *    `(a + b) / two` never quietly becomes `a + b / two`.
 * 2. Your comments survive. They are re-attached by line number, and a blank
 *    line you put between a comment and its code stays put.
 *
 * Formatting is idempotent, so the second run changes nothing, which is what
 * makes it safe to wire into a pre-commit hook.
 */
export function format(source: string, fileName = "<source>"): string {
  const tokens = tokenize(source, fileName, true);
  const comments = tokens.filter(
    (t) => t.type === TokenType.LineComment || t.type === TokenType.BlockComment
  );
  const code = tokens.filter(
    (t) => t.type !== TokenType.LineComment && t.type !== TokenType.BlockComment
  );
  const program = new Parser(code, fileName).parseProgram();
  const p = new Printer(comments);

  let first = true;
  for (const decl of program.body) {
    if (!first) p.blank();
    first = false;
    p.flushBefore(decl.line);
    p.keepGapBefore(decl.line);
    if (decl.kind === "FunctionDecl") {
      p.printFunction(decl);
    } else if (decl.kind === "DirectiveDecl") {
      const args = decl.args.map((a) => JSON.stringify(a)).join(", ");
      p.line(`@${decl.namespace}.${decl.action}(${args});`, decl.line);
    } else if (decl.kind === "ImportDecl") {
      p.line(`import { ${decl.names.join(", ")} } from ${JSON.stringify(decl.from)};`, decl.line);
    } else if (decl.kind === "StructDecl") {
      p.printStruct(decl);
    } else {
      p.line(p.renderVarDecl(decl) + ";", decl.line);
    }
  }
  p.flushRemaining();
  return p.toString();
}

class Printer {
  private out: string[] = [];
  private depth = 0;
  private cursor = 0;
  /** Source line the last printed statement ended on, for blank-line keeping. */
  private lastEndLine: number | undefined;
  /** Source line the last flushed comment ended on. */
  private lastCommentEndLine: number | undefined;

  constructor(private comments: Token[]) {}

  line(text: string, srcLine?: number) {
    this.out.push(INDENT.repeat(this.depth) + text);
    if (srcLine !== undefined) this.trailing(srcLine);
  }

  blank() {
    if (this.out.length && this.out[this.out.length - 1] !== "") this.out.push("");
  }

  /**
   * Emit every comment sitting above `srcLine`, at the current indent.
   * Returns whether anything was emitted, because a statement with a comment
   * above it measures its spacing from the comment, not from the line before.
   */
  flushBefore(srcLine: number): boolean {
    let flushed = false;
    while (this.cursor < this.comments.length && this.comments[this.cursor].line < srcLine) {
      const c = this.comments[this.cursor++];
      if (!flushed) this.keepGap(c.line);
      this.out.push(INDENT.repeat(this.depth) + renderComment(c));
      this.lastCommentEndLine = c.line + countLines(c.value) - 1;
      flushed = true;
    }
    if (!flushed) this.lastCommentEndLine = undefined;
    return flushed;
  }

  /** A blank line between a comment and the code under it means something. */
  keepGapBefore(srcLine: number) {
    if (this.lastCommentEndLine !== undefined && srcLine - this.lastCommentEndLine > 1) this.blank();
  }

  /** So does a blank line between two statements. */
  keepGap(srcLine: number) {
    if (this.lastEndLine !== undefined && srcLine - this.lastEndLine > 1) this.blank();
  }

  private trailing(srcLine: number) {
    while (this.cursor < this.comments.length && this.comments[this.cursor].line === srcLine) {
      const c = this.comments[this.cursor++];
      this.out[this.out.length - 1] += "  " + renderComment(c);
    }
  }

  flushRemaining() {
    while (this.cursor < this.comments.length) {
      this.out.push(INDENT.repeat(this.depth) + renderComment(this.comments[this.cursor++]));
    }
  }

  toString(): string {
    return this.out.join("\n").replace(/\n+$/, "") + "\n";
  }

  printFunction(fn: N.FunctionDecl) {
    const params = fn.params.map((p) => `${N.typeSpelling(p.paramType)} ${p.name}`).join(", ");
    this.line(
      `${fn.visibility} function: ${N.typeSpelling(fn.returnType)} ${fn.name}(${params}) {`,
      fn.line
    );
    this.depth++;
    this.printBody(fn.body);
    this.depth--;
    this.line("}");
    this.lastEndLine = fn.body.endLine;
  }

  /** One field per line, because a struct on one line is a dare. */
  printStruct(decl: N.StructDecl) {
    this.line(`struct ${decl.name} {`, decl.line);
    this.depth++;
    for (const f of decl.fields) {
      this.line(`${N.typeSpelling(f.fieldType)} ${f.name};`, f.fieldType.line);
    }
    this.depth--;
    this.line("}");
    this.lastEndLine = decl.endLine;
  }

  printBody(block: N.Block) {
    // Blank lines are measured against the previous statement, and the first
    // statement in a block has no previous statement, only an opening brace.
    this.lastEndLine = block.line;
    for (const stmt of block.body) this.printStmt(stmt);
  }

  printStmt(stmt: N.Stmt) {
    const hadComments = this.flushBefore(stmt.line);
    this.keepGapBefore(stmt.line);
    if (!hadComments) this.keepGap(stmt.line);
    switch (stmt.kind) {
      case "VarDecl":
        this.line(this.renderVarDecl(stmt) + ";", stmt.line);
        break;
      case "Block":
        this.line("{", stmt.line);
        this.depth++;
        this.printBody(stmt);
        this.depth--;
        this.line("}");
        break;
      case "IfStmt":
        this.printIf(stmt);
        break;
      case "WhileStmt":
        this.line(`while (${this.expr(stmt.test)}) {`, stmt.line);
        this.depth++;
        this.printBody(stmt.body);
        this.depth--;
        this.line("}");
        break;
      case "ForStmt": {
        const init = stmt.init
          ? stmt.init.kind === "VarDecl"
            ? this.renderVarDecl(stmt.init)
            : this.expr(stmt.init.expression)
          : "";
        const test = stmt.test ? this.expr(stmt.test) : "";
        const update = stmt.update ? this.expr(stmt.update) : "";
        this.line(`for (${init}; ${test}; ${update}) {`, stmt.line);
        this.depth++;
        this.printBody(stmt.body);
        this.depth--;
        this.line("}");
        break;
      }
      case "ReturnStmt":
        this.line(`return${stmt.argument ? " " + this.expr(stmt.argument) : ""};`, stmt.line);
        break;
      case "BreakStmt":
        this.line("break;", stmt.line);
        break;
      case "ContinueStmt":
        this.line("continue;", stmt.line);
        break;
      case "ExprStmt":
        this.line(this.expr(stmt.expression) + ";", stmt.line);
        break;
    }
    this.lastEndLine = endLineOf(stmt);
  }

  private printIf(stmt: N.IfStmt) {
    this.line(`if (${this.expr(stmt.test)}) {`, stmt.line);
    this.depth++;
    this.printBody(stmt.consequent);
    this.depth--;
    this.printAlternate(stmt.alternate);
  }

  /** `else { }`, `else if { }`, or the closing brace. Whichever you had. */
  private printAlternate(alt: N.Block | N.IfStmt | null) {
    if (!alt) {
      this.line("}");
      return;
    }
    this.flushBefore(alt.line);
    if (alt.kind === "IfStmt") {
      this.line(`} else if (${this.expr(alt.test)}) {`, alt.line);
      this.depth++;
      this.printBody(alt.consequent);
      this.depth--;
      this.printAlternate(alt.alternate);
      return;
    }
    this.line("} else {", alt.line);
    this.depth++;
    this.printBody(alt);
    this.depth--;
    this.line("}");
  }

  renderVarDecl(stmt: N.VarDecl): string {
    const kw = stmt.isConst ? "const" : "let";
    return `${kw}: ${N.typeSpelling(stmt.varType)} ${stmt.name}${
      stmt.init ? " = " + this.expr(stmt.init) : ""
    }`;
  }

  private expr(e: N.Expr): string {
    switch (e.kind) {
      case "IntLiteral":
        return String(e.value);
      case "FloatLiteral":
        // 2.0 must not come back out as "2", or the next parse calls it an int
        return Number.isInteger(e.value) ? `${e.value}.0` : String(e.value);
      case "StringLiteral":
        return JSON.stringify(e.value);
      case "BoolLiteral":
        return String(e.value);
      case "Identifier":
        return e.name;
      case "MemberExpr":
        return `${this.sub(e.object, PREC_POSTFIX)}.${e.property}`;
      case "CallExpr":
        return `${this.sub(e.callee, PREC_POSTFIX)}(${e.args.map((a) => this.expr(a)).join(", ")})`;
      case "BinaryExpr": {
        const prec = PREC[e.operator] ?? 6;
        const left = this.sub(e.left, prec);
        // Every binary operator here is left-associative, so the right operand
        // needs parens at equal precedence too: a - (b - c) is not a - b - c.
        const right = this.sub(e.right, prec + 1);
        return `${left} ${e.operator} ${right}`;
      }
      case "UnaryExpr": {
        if (!e.prefix) return `${this.sub(e.argument, PREC_POSTFIX)}${e.operator}`;
        const arg = this.sub(e.argument, PREC_PREFIX);
        // "- -x" must not come out as "--x", which is a different animal.
        if (
          (e.operator === "-" || e.operator === "--" || e.operator === "++") &&
          e.argument.kind === "UnaryExpr" &&
          e.argument.prefix &&
          (e.argument.operator === "-" || e.argument.operator === "--" || e.argument.operator === "++") &&
          !arg.startsWith("(")
        ) {
          return `${e.operator}(${arg})`;
        }
        return `${e.operator}${arg}`;
      }
      case "AssignExpr":
        return `${this.expr(e.target)} ${e.operator} ${this.expr(e.value)}`;
      case "CastExpr":
        return `${this.sub(e.expr, PREC_POSTFIX)} -> ${N.typeSpelling(e.targetType)}`;
      case "IndexExpr":
        return `${this.sub(e.object, PREC_POSTFIX)}[${this.expr(e.index)}]`;
      case "ArrayLiteral":
        return `[${e.elements.map((el) => this.expr(el)).join(", ")}]`;
      case "NewArrayExpr":
        return `new ${N.typeSpelling(e.elemType)}[${this.expr(e.size)}]`;
    }
  }

  /** Render `e`, wrapped in parens if it binds looser than `minPrec`. */
  private sub(e: N.Expr, minPrec: number): string {
    const text = this.expr(e);
    return precOf(e) < minPrec ? `(${text})` : text;
  }
}

function precOf(e: N.Expr): number {
  switch (e.kind) {
    case "AssignExpr":
      return PREC_ASSIGN;
    case "BinaryExpr":
      return PREC[e.operator] ?? 6;
    case "UnaryExpr":
      return e.prefix ? PREC_PREFIX : PREC_POSTFIX;
    case "CallExpr":
    case "MemberExpr":
    case "CastExpr":
    case "IndexExpr":
      return PREC_POSTFIX;
    default:
      return PREC_ATOM;
  }
}

/** The source line a statement finishes on, so blank lines can be measured. */
function endLineOf(stmt: N.Stmt): number {
  switch (stmt.kind) {
    case "Block":
      return stmt.endLine;
    case "WhileStmt":
    case "ForStmt":
      return stmt.body.endLine;
    case "IfStmt":
      return ifEndLine(stmt);
    default:
      return stmt.line;
  }
}

function ifEndLine(stmt: N.IfStmt): number {
  if (!stmt.alternate) return stmt.consequent.endLine;
  return stmt.alternate.kind === "IfStmt" ? ifEndLine(stmt.alternate) : stmt.alternate.endLine;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function renderComment(t: Token): string {
  return t.type === TokenType.LineComment ? `//${t.value}` : t.value;
}
