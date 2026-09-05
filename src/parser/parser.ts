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
      } else if (this.at(TokenType.Public) || this.at(TokenType.Private) || this.at(TokenType.Function)) {
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

  private parseType(): N.TypeNode {
    const t = this.peek();
    if (t.type === TokenType.Identifier) {
      this.advance();
      return { name: t.value, line: t.line, column: t.column };
    }
    throw new ParseError(`Expected a type name but got '${t.value || t.type}'`, t.line, t.column);
  }

  private parseFunctionDecl(): N.FunctionDecl {
    let visibility: N.Visibility = "public";
    if (this.at(TokenType.Public)) {
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
    this.expect(TokenType.Colon, `Expected ':' after '${declTok.value}' (e.g. ${declTok.value}: int x = 1;)`);
    const varType = this.parseType();
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
    this.expect(TokenType.LBrace);
    const body: N.Stmt[] = [];
    while (!this.at(TokenType.RBrace)) {
      body.push(this.parseStatement());
    }
    this.expect(TokenType.RBrace);
    return { kind: "Block", body };
  }

  private parseStatement(): N.Stmt {
    if (this.at(TokenType.Let) || this.at(TokenType.Const)) return this.parseVarDecl();
    if (this.at(TokenType.LBrace)) return this.parseBlock();
    if (this.at(TokenType.If)) return this.parseIf();
    if (this.at(TokenType.While)) return this.parseWhile();
    if (this.at(TokenType.For)) return this.parseFor();
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
    const consequent = this.parseBlock();
    let alternate: N.Block | N.IfStmt | null = null;
    if (this.at(TokenType.Else)) {
      this.advance();
      alternate = this.at(TokenType.If) ? this.parseIf() : this.parseBlock();
    }
    return { kind: "IfStmt", test, consequent, alternate, line: t.line };
  }

  private parseWhile(): N.WhileStmt {
    const t = this.expect(TokenType.While);
    this.expect(TokenType.LParen);
    const test = this.parseExpr();
    this.expect(TokenType.RParen);
    const body = this.parseBlock();
    return { kind: "WhileStmt", test, body, line: t.line };
  }

  private parseFor(): N.ForStmt {
    const t = this.expect(TokenType.For);
    this.expect(TokenType.LParen);
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
    const body = this.parseBlock();
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
    const left = this.parseLogicalOr();
    const assignOps = new Set([
      TokenType.Assign,
      TokenType.PlusAssign,
      TokenType.MinusAssign,
      TokenType.StarAssign,
      TokenType.SlashAssign,
    ]);
    if (assignOps.has(this.peek().type)) {
      const opTok = this.advance();
      const value = this.parseAssign();
      return { kind: "AssignExpr", operator: opTok.value, target: left, value, line: opTok.line };
    }
    return left;
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
    let left = this.parseEquality();
    while (this.at(TokenType.And)) {
      const t = this.advance();
      const right = this.parseEquality();
      left = { kind: "BinaryExpr", operator: "&&", left, right, line: t.line };
    }
    return left;
  }

  private parseEquality(): N.Expr {
    let left = this.parseRelational();
    while (this.at(TokenType.Eq) || this.at(TokenType.NotEq)) {
      const t = this.advance();
      const right = this.parseRelational();
      left = { kind: "BinaryExpr", operator: t.value, left, right, line: t.line };
    }
    return left;
  }

  private parseRelational(): N.Expr {
    let left = this.parseAdditive();
    while ([TokenType.Lt, TokenType.Gt, TokenType.LtEq, TokenType.GtEq].includes(this.peek().type)) {
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
    if (this.at(TokenType.Minus) || this.at(TokenType.Not) || this.at(TokenType.Increment) || this.at(TokenType.Decrement)) {
      const t = this.advance();
      const argument = this.parseUnary();
      return { kind: "UnaryExpr", operator: t.value, argument, prefix: true, line: t.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): N.Expr {
    let expr = this.parseCallOrMember();
    while (this.at(TokenType.Increment) || this.at(TokenType.Decrement)) {
      const t = this.advance();
      expr = { kind: "UnaryExpr", operator: t.value, argument: expr, prefix: false, line: t.line };
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
      case TokenType.LParen: {
        this.advance();
        const expr = this.parseExpr();
        this.expect(TokenType.RParen);
        return expr;
      }
      default:
        throw new ParseError(`Unexpected token '${t.value || t.type}' in expression`, t.line, t.column);
    }
  }
}

export function parse(source: string, fileName = "<source>"): N.Program {
  const tokens = tokenize(source, fileName);
  return new Parser(tokens, fileName).parseProgram();
}
