import { Token, TokenType } from "../lexer/tokens";
import { tokenize } from "../lexer/lexer";
import * as N from "../ast/nodes";

export class ParseError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

/**
 * Recursive-descent parser for yarescript.
 *
 * Grammar highlights (see docs/LANGUAGE.md for the full spec):
 *   program        -> (importDecl | functionDecl | varDecl)*
 *   functionDecl   -> visibility? "function" ":" type IDENT "(" params? ")" block
 *   varDecl        -> ("let" | "const") ":" type IDENT ("=" expr)? ";"
 *   block          -> "{" statement* "}"
 *   cast           -> postfix ("->" type)*
 *
 * Hand written on purpose. A generated parser would be tidier and about a
 * third as fun to debug."
 */
export class Parser {
  private pos = 0;

  constructor(private tokens: Token[], private fileName = "<source>") {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private at(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private expect(type: TokenType, message?: string): Token {
    if (!this.at(type)) {
      const t = this.peek();
      throw new ParseError(
        message ?? `Expected ${type} but got ${t.type} ('${t.value}')`,
        t.line,
        t.column
      );
    }
    return this.advance();
  }

  parseProgram(): N.Program {
    const body: N.Program["body"] = [];
    while (!this.at(TokenType.EOF)) {
      if (this.at(TokenType.Import)) {
        body.push(this.parseImport());
      } else if (this.at(TokenType.Struct)) {
        body.push(this.parseStructDecl());
      } else if (this.at(TokenType.At)) {
        body.push(this.parseDirective());
      } else if (
        this.at(TokenType.Public) ||
        this.at(TokenType.Private) ||
        this.at(TokenType.Export) ||
        this.at(TokenType.Function)
      ) {
        body.push(this.parseFunctionDecl());
      } else if (this.at(TokenType.Let) || this.at(TokenType.Const)) {
        body.push(this.parseVarDecl());
      } else {
        const t = this.peek();
        throw new ParseError(`Unexpected token '${t.value || t.type}' at top level`, t.line, t.column);
      }
    }
    return { kind: "Program", body };
  }

  /** `@modules.import("json")` and friends. */
  private parseDirective(): N.DirectiveDecl {
    const at = this.expect(TokenType.At);
    const namespace = this.expectDirectiveWord("Expected a directive name after '@'");
    this.expect(TokenType.Dot, `Expected '.' in '@${namespace}.<action>'`);
    const action = this.expectDirectiveWord(`Expected an action after '@${namespace}.'`);
    this.expect(TokenType.LParen);
    const args: string[] = [];
    while (!this.at(TokenType.RParen)) {
      args.push(this.expect(TokenType.StringLiteral, `Directive arguments must be strings`).value);
      if (this.at(TokenType.Comma)) this.advance();
    }
    this.expect(TokenType.RParen);
    this.expect(TokenType.Semicolon);
    return { kind: "DirectiveDecl", namespace, action, args, line: at.line };
  }

  /**
   * A word in a directive. `import` is a keyword everywhere else in the
   * language, and `@modules.import` is exactly the directive that needs it,
   * so keywords are welcome here.
   */
  private expectDirectiveWord(message: string): string {
    const t = this.peek();
    if (t.type === TokenType.Identifier || /^[a-z][a-zA-Z0-9]*$/.test(t.value)) {
      this.advance();
      return t.value;
    }
    throw new ParseError(`${message} (got '${t.value || t.type}')`, t.line, t.column);
  }

  /** `struct Point { int x; int y; }`, fields in the order you wrote them. */
  private parseStructDecl(): N.StructDecl {
    const kw = this.expect(TokenType.Struct);
    const name = this.expect(TokenType.Identifier, "Expected a name after 'struct'").value;
    this.expect(TokenType.LBrace, `Expected '{' to open struct '${name}'`);
    const fields: { name: string; fieldType: N.TypeNode }[] = [];
    while (!this.at(TokenType.RBrace)) {
      const fieldType = this.parseType();
      const fname = this.expect(TokenType.Identifier, "Expected a field name").value;
      this.expect(TokenType.Semicolon, `Expected ';' after field '${fname}'`);
      fields.push({ name: fname, fieldType });
    }
    const close = this.expect(TokenType.RBrace);
    return { kind: "StructDecl", name, fields, line: kw.line, endLine: close.line };
  }

  private parseImport(): N.ImportDecl {
    const start = this.expect(TokenType.Import);
    const names: string[] = [];
    if (this.at(TokenType.LBrace)) {
      this.advance();
      while (!this.at(TokenType.RBrace)) {
        names.push(this.expect(TokenType.Identifier).value);
        if (this.at(TokenType.Comma)) this.advance();
      }
      this.expect(TokenType.RBrace);
    } else {
      names.push(this.expect(TokenType.Identifier).value);
    }
    this.expect(TokenType.From);
    const from = this.expect(TokenType.StringLiteral).value;
    this.expect(TokenType.Semicolon);
    return { kind: "ImportDecl", names, from, line: start.line };
  }

  // A type is an identifier that the checker has opinions about. The parser
  // stays out of it, which is why `let: banana x = 1;` fails politely later
  // instead of here.
  private parseType(): N.TypeNode {
    const t = this.peek();
    if (t.type === TokenType.Identifier) {
      this.advance();
      // `int[]` is `int` with brackets on the end, and `int[][]` is an array of
      // those. The brackets are part of the type, not part of the expression.
      let dims = 0;
      while (this.at(TokenType.LBracket) && this.peek(1).type === TokenType.RBracket) {
        this.advance();
        this.advance();
        dims++;
      }
      return { name: t.value, dims, line: t.line, column: t.column };
    }
    throw new ParseError(`Expected a type name but got '${t.value || t.type}'`, t.line, t.column);
  }

  private parseFunctionDecl(): N.FunctionDecl {
    let visibility: N.Visibility = "public";
    // `export` is accepted as a friendlier spelling of `public`. Both mean the
    // same thing: the host can call it.
    if (this.at(TokenType.Public) || this.at(TokenType.Export)) {
      this.advance();
      visibility = "public";
    } else if (this.at(TokenType.Private)) {
      this.advance();
      visibility = "private";
    }
    const fnTok = this.expect(TokenType.Function);
    this.expect(TokenType.Colon, "Expected ':' after 'function' (e.g. function: void main())");
    const returnType = this.parseType();
    const name = this.expect(TokenType.Identifier).value;
    this.expect(TokenType.LParen);
    const params: N.Param[] = [];
    while (!this.at(TokenType.RParen)) {
      const paramType = this.parseType();
      const pname = this.expect(TokenType.Identifier).value;
      params.push({ name: pname, paramType });
      if (this.at(TokenType.Comma)) this.advance();
    }
    this.expect(TokenType.RParen);
    const body = this.parseBlock();
    return { kind: "FunctionDecl", name, visibility, returnType, params, body, line: fnTok.line };
  }

  private parseVarDecl(): N.VarDecl {
    const declTok = this.advance(); // let | const
    const isConst = declTok.type === TokenType.Const;
    // `let: int x = 1;` says the type, `let x = 1;` lets the checker work it
    // out from the right-hand side.
    let varType: N.TypeNode | null = null;
    if (this.at(TokenType.Colon)) {
      this.advance();
      varType = this.parseType();
    }
    const name = this.expect(TokenType.Identifier).value;
    let init: N.Expr | null = null;
    if (this.at(TokenType.Assign)) {
      this.advance();
      init = this.parseExpr();
    }
    this.expect(TokenType.Semicolon);
    return { kind: "VarDecl", isConst, varType, name, init, line: declTok.line };
  }

  private parseBlock(): N.Block {
    const brace = this.expect(TokenType.LBrace);
    const body: N.Stmt[] = [];
    while (!this.at(TokenType.RBrace)) {
      body.push(this.parseStatement());
    }
    const close = this.expect(TokenType.RBrace);
    return { kind: "Block", body, line: brace.line, endLine: close.line };
  }

  private parseStatement(): N.Stmt {
    if (this.at(TokenType.Let) || this.at(TokenType.Const)) return this.parseVarDecl();
    if (this.at(TokenType.LBrace)) return this.parseBlock();
    if (this.at(TokenType.If)) return this.parseIf();
    if (this.at(TokenType.While)) return this.parseWhile();
    if (this.at(TokenType.For)) return this.parseFor();
    if (this.at(TokenType.Do)) return this.parseDoWhile();
    if (this.at(TokenType.Switch)) return this.parseSwitch();
    if (this.at(TokenType.Return)) return this.parseReturn();
    if (this.at(TokenType.Break)) {
      const t = this.advance();
      this.expect(TokenType.Semicolon);
      return { kind: "BreakStmt", line: t.line };
    }
    if (this.at(TokenType.Continue)) {
      const t = this.advance();
      this.expect(TokenType.Semicolon);
      return { kind: "ContinueStmt", line: t.line };
    }
    const line = this.peek().line;
    const expr = this.parseExpr();
    this.expect(TokenType.Semicolon);
    return { kind: "ExprStmt", expression: expr, line };
  }

  private parseIf(): N.IfStmt {
    const t = this.expect(TokenType.If);
    this.expect(TokenType.LParen);
    const test = this.parseExpr();
    this.expect(TokenType.RParen);
    const consequent = this.parseBody();
    let alternate: N.Block | N.IfStmt | null = null;
    if (this.at(TokenType.Else)) {
      this.advance();
      alternate = this.at(TokenType.If) ? this.parseIf() : this.parseBody();
    }
    return { kind: "IfStmt", test, consequent, alternate, line: t.line };
  }

  private parseWhile(): N.WhileStmt {
    const t = this.expect(TokenType.While);
    this.expect(TokenType.LParen);
    const test = this.parseExpr();
    this.expect(TokenType.RParen);
    const body = this.parseBody();
    return { kind: "WhileStmt", test, body, line: t.line };
  }

  private parseDoWhile(): N.DoWhileStmt {
    const t = this.expect(TokenType.Do);
    const body = this.parseBody();
    this.expect(TokenType.While, "Expected 'while' to close a 'do' block");
    this.expect(TokenType.LParen);
    const test = this.parseExpr();
    this.expect(TokenType.RParen);
    const semi = this.expect(TokenType.Semicolon);
    return { kind: "DoWhileStmt", test, body, line: t.line, endLine: semi.line };
  }

  private parseSwitch(): N.SwitchStmt {
    const t = this.expect(TokenType.Switch);
    this.expect(TokenType.LParen);
    const discriminant = this.parseExpr();
    this.expect(TokenType.RParen);
    this.expect(TokenType.LBrace, "Expected '{' to open a switch body");
    const cases: N.SwitchCase[] = [];
    while (!this.at(TokenType.RBrace)) {
      let test: N.Expr | null = null;
      const caseTok = this.peek();
      if (this.at(TokenType.Case)) {
        this.advance();
        test = this.parseExpr();
      } else if (this.at(TokenType.Default)) {
        this.advance();
      } else {
        const bad = this.peek();
        throw new ParseError(
          `Expected 'case' or 'default' in a switch body, got '${bad.value || bad.type}'`,
          bad.line,
          bad.column
        );
      }
      this.expect(TokenType.Colon, "Expected ':' after a case value");
      const consequent: N.Stmt[] = [];
      while (!this.at(TokenType.Case) && !this.at(TokenType.Default) && !this.at(TokenType.RBrace)) {
        consequent.push(this.parseStatement());
      }
      cases.push({ kind: "SwitchCase", test, consequent, line: caseTok.line });
    }
    const close = this.expect(TokenType.RBrace, "Expected '}' to close a switch body");
    return { kind: "SwitchStmt", discriminant, cases, line: t.line, endLine: close.line };
  }

  /**
   * A statement body. Braces are optional for a single statement, the way they
   * are in the languages you came here from, and `yare fmt` puts them back.
   */
  private parseBody(): N.Block {
    if (this.at(TokenType.LBrace)) return this.parseBlock();
    const stmt = this.parseStatement();
    return { kind: "Block", body: [stmt], line: stmt.line, endLine: stmt.line };
  }

  /**
   * Does the head of the `for (...)` we are looking at introduce a `of` or
   * `in` loop? Decided by scanning tokens, because `of` and `in` stay ordinary
   * identifiers everywhere else and only mean something here.
   */
  private forHeadIsEach(): string | null {
    let depth = 0;
    for (let offset = 1; ; offset++) {
      const t = this.peek(offset);
      if (t.type === TokenType.EOF) return null;
      if (t.type === TokenType.LParen) depth++;
      else if (t.type === TokenType.RParen) {
        if (depth === 0) return null;
        depth--;
      } else if (depth === 0 && t.type === TokenType.Semicolon) {
        return null;
      } else if (depth === 0 && t.type === TokenType.Identifier && (t.value === "of" || t.value === "in")) {
        return t.value;
      }
    }
  }

  private parseFor(): N.ForStmt | N.ForOfStmt | N.ForInStmt {
    const t = this.expect(TokenType.For);
    this.expect(TokenType.LParen);
    const each = this.forHeadIsEach();
    if (each) {
      let itemType: N.TypeNode | null = null;
      let name: string;
      if (this.at(TokenType.Let) || this.at(TokenType.Const)) {
        this.advance();
        if (this.at(TokenType.Colon)) {
          this.advance();
          itemType = this.parseType();
        }
        name = this.expect(TokenType.Identifier).value;
      } else {
        name = this.expect(TokenType.Identifier).value;
      }
      this.advance(); // of | in
      const iterable = this.parseExpr();
      this.expect(TokenType.RParen);
      const body = this.parseBody();
      if (each === "of") return { kind: "ForOfStmt", itemType, name, iterable, body, line: t.line };
      return { kind: "ForInStmt", indexType: itemType, name, iterable, body, line: t.line };
    }
    let init: N.VarDecl | N.ExprStmt | null = null;
    if (!this.at(TokenType.Semicolon)) {
      if (this.at(TokenType.Let) || this.at(TokenType.Const)) {
        init = this.parseVarDecl();
      } else {
        const line = this.peek().line;
        const expr = this.parseExpr();
        this.expect(TokenType.Semicolon);
        init = { kind: "ExprStmt", expression: expr, line };
      }
    } else {
      this.advance();
    }
    let test: N.Expr | null = null;
    if (!this.at(TokenType.Semicolon)) test = this.parseExpr();
    this.expect(TokenType.Semicolon);
    let update: N.Expr | null = null;
    if (!this.at(TokenType.RParen)) update = this.parseExpr();
    this.expect(TokenType.RParen);
    const body = this.parseBody();
    return { kind: "ForStmt", init, test, update, body, line: t.line };
  }

  private parseReturn(): N.ReturnStmt {
    const t = this.expect(TokenType.Return);
    let argument: N.Expr | null = null;
    if (!this.at(TokenType.Semicolon)) argument = this.parseExpr();
    this.expect(TokenType.Semicolon);
    return { kind: "ReturnStmt", argument, line: t.line };
  }

  // ---- Expressions (precedence climbing) ----

  private parseExpr(): N.Expr {
    return this.parseAssign();
  }

  private parseAssign(): N.Expr {
    const left = this.parseConditional();
    const assignOps = new Set([
      TokenType.Assign,
      TokenType.PlusAssign,
      TokenType.MinusAssign,
      TokenType.StarAssign,
      TokenType.SlashAssign,
      TokenType.PercentAssign,
      TokenType.AmpAssign,
      TokenType.PipeAssign,
      TokenType.CaretAssign,
      TokenType.ShlAssign,
      TokenType.ShrAssign,
    ]);
    if (assignOps.has(this.peek().type)) {
      const opTok = this.advance();
      const value = this.parseAssign();
      return { kind: "AssignExpr", operator: opTok.value, target: left, value, line: opTok.line };
    }
    return left;
  }

  /** `a ? b : c`. Right associative, and the arms may be assignments. */
  private parseConditional(): N.Expr {
    const test = this.parseLogicalOr();
    if (!this.at(TokenType.Question)) return test;
    const t = this.advance();
    const consequent = this.parseAssign();
    this.expect(TokenType.Colon, "Expected ':' in the middle of a ternary");
    const alternate = this.parseAssign();
    return { kind: "ConditionalExpr", test, consequent, alternate, line: t.line };
  }

  private parseLogicalOr(): N.Expr {
    let left = this.parseLogicalAnd();
    while (this.at(TokenType.Or)) {
      const t = this.advance();
      const right = this.parseLogicalAnd();
      left = { kind: "BinaryExpr", operator: "||", left, right, line: t.line };
    }
    return left;
  }

  private parseLogicalAnd(): N.Expr {
    let left = this.parseBitwiseOr();
    while (this.at(TokenType.And)) {
      const t = this.advance();
      const right = this.parseBitwiseOr();
      left = { kind: "BinaryExpr", operator: "&&", left, right, line: t.line };
    }
    return left;
  }

  // The three bitwise levels sit between && and ==, which is where every
  // C-shaped language puts them, so `a & 1 == 0` means what you expect it to.
  private parseBitwiseOr(): N.Expr {
    let left = this.parseBitwiseXor();
    while (this.at(TokenType.Pipe)) {
      const t = this.advance();
      const right = this.parseBitwiseXor();
      left = { kind: "BinaryExpr", operator: "|", left, right, line: t.line };
    }
    return left;
  }

  private parseBitwiseXor(): N.Expr {
    let left = this.parseBitwiseAnd();
    while (this.at(TokenType.Caret)) {
      const t = this.advance();
      const right = this.parseBitwiseAnd();
      left = { kind: "BinaryExpr", operator: "^", left, right, line: t.line };
    }
    return left;
  }

  private parseBitwiseAnd(): N.Expr {
    let left = this.parseEquality();
    while (this.at(TokenType.Amp)) {
      const t = this.advance();
      const right = this.parseEquality();
      left = { kind: "BinaryExpr", operator: "&", left, right, line: t.line };
    }
    return left;
  }

  private parseEquality(): N.Expr {
    let left = this.parseRelational();
    while (
      this.at(TokenType.Eq) ||
      this.at(TokenType.NotEq) ||
      this.at(TokenType.EqEqEq) ||
      this.at(TokenType.NotEqEq)
    ) {
      const t = this.advance();
      const right = this.parseRelational();
      left = { kind: "BinaryExpr", operator: t.value, left, right, line: t.line };
    }
    return left;
  }

  private parseRelational(): N.Expr {
    let left = this.parseShift();
    while ([TokenType.Lt, TokenType.Gt, TokenType.LtEq, TokenType.GtEq].includes(this.peek().type)) {
      const t = this.advance();
      const right = this.parseShift();
      left = { kind: "BinaryExpr", operator: t.value, left, right, line: t.line };
    }
    return left;
  }

  private parseShift(): N.Expr {
    let left = this.parseAdditive();
    while (this.at(TokenType.Shl) || this.at(TokenType.Shr)) {
      const t = this.advance();
      const right = this.parseAdditive();
      left = { kind: "BinaryExpr", operator: t.value, left, right, line: t.line };
    }
    return left;
  }

  private parseAdditive(): N.Expr {
    let left = this.parseMultiplicative();
    while (this.at(TokenType.Plus) || this.at(TokenType.Minus)) {
      const t = this.advance();
      const right = this.parseMultiplicative();
      left = { kind: "BinaryExpr", operator: t.value, left, right, line: t.line };
    }
    return left;
  }

  private parseMultiplicative(): N.Expr {
    let left = this.parseUnary();
    while (this.at(TokenType.Star) || this.at(TokenType.Slash) || this.at(TokenType.Percent)) {
      const t = this.advance();
      const right = this.parseUnary();
      left = { kind: "BinaryExpr", operator: t.value, left, right, line: t.line };
    }
    return left;
  }

  private parseUnary(): N.Expr {
    if (
      this.at(TokenType.Minus) ||
      this.at(TokenType.Not) ||
      this.at(TokenType.Increment) ||
      this.at(TokenType.Decrement) ||
      this.at(TokenType.Tilde)
    ) {
      const t = this.advance();
      const argument = this.parseUnary();
      return { kind: "UnaryExpr", operator: t.value, argument, prefix: true, line: t.line };
    }
    if (this.at(TokenType.TypeOf)) {
      const t = this.advance();
      const argument = this.parseUnary();
      return { kind: "TypeOfExpr", argument, line: t.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): N.Expr {
    let expr = this.parseCallOrMember();
    for (;;) {
      if (this.at(TokenType.Increment) || this.at(TokenType.Decrement)) {
        const t = this.advance();
        expr = { kind: "UnaryExpr", operator: t.value, argument: expr, prefix: false, line: t.line };
        continue;
      }
      if (this.at(TokenType.Arrow)) {
        // The cast arrow. Binds tighter than arithmetic, so `x -> int + 1`
        // means `(x -> int) + 1`, which is what you meant anyway.
        const t = this.advance();
        const targetType = this.parseType();
        expr = { kind: "CastExpr", expr, targetType, line: t.line };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseCallOrMember(): N.Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at(TokenType.LParen)) {
        const t = this.advance();
        const args: N.Expr[] = [];
        while (!this.at(TokenType.RParen)) {
          args.push(this.parseExpr());
          if (this.at(TokenType.Comma)) this.advance();
        }
        this.expect(TokenType.RParen);
        expr = { kind: "CallExpr", callee: expr, args, line: t.line };
      } else if (this.at(TokenType.LBracket)) {
        const t = this.advance();
        const index = this.parseExpr();
        this.expect(TokenType.RBracket, "Expected ']' to close an index");
        expr = { kind: "IndexExpr", object: expr, index, line: t.line };
      } else if (this.at(TokenType.Dot)) {
        const t = this.advance();
        const prop = this.expect(TokenType.Identifier).value;
        expr = { kind: "MemberExpr", object: expr, property: prop, line: t.line };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): N.Expr {
    const t = this.peek();
    switch (t.type) {
      case TokenType.IntLiteral:
        this.advance();
        return { kind: "IntLiteral", value: parseInt(t.value, 10), line: t.line };
      case TokenType.FloatLiteral:
        this.advance();
        return { kind: "FloatLiteral", value: parseFloat(t.value), line: t.line };
      case TokenType.StringLiteral:
        this.advance();
        return { kind: "StringLiteral", value: t.value, line: t.line };
      case TokenType.True:
        this.advance();
        return { kind: "BoolLiteral", value: true, line: t.line };
      case TokenType.False:
        this.advance();
        return { kind: "BoolLiteral", value: false, line: t.line };
      case TokenType.Identifier:
        this.advance();
        return { kind: "Identifier", name: t.value, line: t.line };
      case TokenType.Null:
        this.advance();
        return { kind: "NullLiteral", line: t.line };
      case TokenType.Template:
        this.advance();
        return this.buildTemplate(t.value, t.line);
      case TokenType.LParen: {
        this.advance();
        const expr = this.parseExpr();
        this.expect(TokenType.RParen);
        return expr;
      }
      case TokenType.LBracket: {
        // An array literal. `[]` on its own is refused rather than guessed at:
        // an array with no elements and no declared type is not a type.
        const bracket = this.advance();
        const elements: N.Expr[] = [];
        while (!this.at(TokenType.RBracket)) {
          elements.push(this.parseExpr());
          if (this.at(TokenType.Comma)) this.advance();
        }
        this.expect(TokenType.RBracket, "Expected ']' to close an array literal");
        if (!elements.length) {
          throw new ParseError(
            "An empty array literal has no element type. Declare one: `let: int[] xs = new int[0];`",
            bracket.line,
            bracket.column
          );
        }
        return { kind: "ArrayLiteral", elements, line: bracket.line };
      }
      case TokenType.New: {
        // `new int[5]`: a sized array, zero filled, on the heap.
        const kw = this.advance();
        const elemType = this.parseType();
        this.expect(TokenType.LBracket, `Expected '[' after 'new ${N.typeSpelling(elemType)}'`);
        const size = this.parseExpr();
        this.expect(TokenType.RBracket, "Expected ']' to close the array size");
        return { kind: "NewArrayExpr", elemType, size, line: kw.line };
      }
      default:
        throw new ParseError(`Unexpected token '${t.value || t.type}' in expression`, t.line, t.column);
    }
  }

  /** One expression and nothing after it, which is what `${...}` holds. */
  parseSingleExpression(): N.Expr {
    const expr = this.parseExpr();
    const t = this.peek();
    if (t.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected '${t.value || t.type}' in an expression`, t.line, t.column);
    }
    return expr;
  }

  /**
   * Splits the raw inside of a backtick string into text and interpolations.
   * The interpolation bodies are handed back to `parse`, so anything you can
   * write in an expression you can write inside `${...}`.
   */
  private buildTemplate(raw: string, line: number): N.TemplateExpr {
    const parts: (string | N.Expr)[] = [];
    let buf = "";
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === "\\" && i + 1 < raw.length) {
        const next = raw[i + 1];
        buf += next === "n" ? "\n" : next === "t" ? "\t" : next === "\\" ? "\\" : next;
        i += 2;
        continue;
      }
      if (ch === "$" && raw[i + 1] === "{") {
        let depth = 0;
        let j = i + 1;
        for (; j < raw.length; j++) {
          if (raw[j] === "{") depth++;
          else if (raw[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (j >= raw.length) {
          throw new ParseError("Unterminated ${ in a template string", line, 1);
        }
        parts.push(buf);
        buf = "";
        const inner = raw.slice(i + 2, j);
        const where = `${this.fileName} (template)`;
        parts.push(new Parser(tokenize(inner, where), where).parseSingleExpression());
        i = j + 1;
        continue;
      }
      buf += ch;
      i++;
    }
    parts.push(buf);
    return { kind: "TemplateExpr", parts, line };
  }
}

/** Parse a single struct declaration, which is what the linker slices out. */
export function parseStruct(source: string, fileName = "<source>"): N.StructDecl {
  const program = parse(source, fileName);
  const decl = program.body.find((d): d is N.StructDecl => d.kind === "StructDecl");
  if (!decl) throw new ParseError(`No struct found in ${fileName}`, 1, 1);
  return decl;
}

export function parse(source: string, fileName = "<source>"): N.Program {
  const tokens = tokenize(source, fileName);
  return new Parser(tokens, fileName).parseProgram();
}
