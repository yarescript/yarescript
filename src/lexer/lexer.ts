import { KEYWORDS, Token, TokenType } from "./tokens";

export class LexError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/**
 * Tokenizes yarescript (.ys) source into a flat list of tokens.
 *
 * Comments are thrown away by default, because the parser has no opinions to
 * offer about them. Pass `keepComments` and they come back as tokens, which is
 * how `yare fmt` manages to reformat your code without eating your notes.
 */
export function tokenize(
  source: string,
  fileName = "<source>",
  keepComments = false
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const peek = (offset = 0) => source[i + offset];
  const advance = () => {
    const c = source[i++];
    if (c === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return c;
  };

  const push = (type: TokenType, value: string, startLine: number, startCol: number) => {
    tokens.push({ type, value, line: startLine, column: startCol });
  };

  while (i < source.length) {
    const c = peek();
    const startLine = line;
    const startCol = column;

    // Whitespace. The lexer's least favourite character is all of them.
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    // line comments: everything from here to the newline is somebody's problem
    // for later, and that somebody is not the compiler
    if (c === "/" && peek(1) === "/") {
      let text = "";
      advance();
      advance();
      while (i < source.length && peek() !== "\n") text += advance();
      if (keepComments) push(TokenType.LineComment, text, startLine, startCol);
      continue;
    }

    // block comments: the same idea, but able to sprawl over several lines and
    // occasionally contain a commented-out experiment from six months ago
    if (c === "/" && peek(1) === "*") {
      let text = "/*";
      advance();
      advance();
      while (i < source.length && !(peek() === "*" && peek(1) === "/")) text += advance();
      if (i >= source.length) {
        throw new LexError(`Unterminated block comment in ${fileName}`, startLine, startCol);
      }
      text += advance() + advance(); // the closing */
      if (keepComments) push(TokenType.BlockComment, text, startLine, startCol);
      continue;
    }

    // strings: the only place a backslash is a personality trait
    if (c === '"') {
      advance();
      let value = "";
      while (i < source.length && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          const esc = advance();
          const map: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            '"': '"',
            "\\": "\\",
            "0": "\0",
          };
          value += map[esc] ?? esc;
        } else {
          value += advance();
        }
      }
      if (i >= source.length) {
        throw new LexError(`Unterminated string literal in ${fileName}`, startLine, startCol);
      }
      advance(); // closing quote
      push(TokenType.StringLiteral, value, startLine, startCol);
      continue;
    }

    // numbers. Underscores are ignored, so 1_000_000 reads nicely and 1__0 is
    // allowed but deserves what it gets.
    if (isDigit(c)) {
      let value = "";
      let isFloat = false;
      while (i < source.length && (isDigit(peek()) || peek() === "_")) {
        const d = advance();
        if (d !== "_") value += d;
      }
      if (peek() === "." && isDigit(peek(1))) {
        isFloat = true;
        value += advance(); // .
        while (i < source.length && isDigit(peek())) value += advance();
      }
      push(isFloat ? TokenType.FloatLiteral : TokenType.IntLiteral, value, startLine, startCol);
      continue;
    }

    // identifiers and keywords. Longest match wins, which matters as soon as
    // somebody writes `iffy` and expects it not to become `if` + `fy`.
    if (isIdentStart(c)) {
      let value = "";
      while (i < source.length && isIdentPart(peek())) value += advance();
      const kw = KEYWORDS[value];
      if (kw) {
        push(kw, value, startLine, startCol);
      } else {
        push(TokenType.Identifier, value, startLine, startCol);
      }
      continue;
    }

    // two-char operators, checked before the one-char ones so that `->` is an
    // arrow and not a minus sign followed by greater-than
    const two = c + (peek(1) ?? "");
    const twoCharMap: Record<string, TokenType> = {
      "==": TokenType.Eq,
      "!=": TokenType.NotEq,
      "<=": TokenType.LtEq,
      ">=": TokenType.GtEq,
      "&&": TokenType.And,
      "||": TokenType.Or,
      "+=": TokenType.PlusAssign,
      "-=": TokenType.MinusAssign,
      "*=": TokenType.StarAssign,
      "/=": TokenType.SlashAssign,
      "++": TokenType.Increment,
      "--": TokenType.Decrement,
      "->": TokenType.Arrow,
    };
    if (twoCharMap[two]) {
      advance();
      advance();
      push(twoCharMap[two], two, startLine, startCol);
      continue;
    }

    const oneCharMap: Record<string, TokenType> = {
      ":": TokenType.Colon,
      ";": TokenType.Semicolon,
      ",": TokenType.Comma,
      ".": TokenType.Dot,
      "(": TokenType.LParen,
      ")": TokenType.RParen,
      "{": TokenType.LBrace,
      "}": TokenType.RBrace,
      "[": TokenType.LBracket,
      "]": TokenType.RBracket,
      "+": TokenType.Plus,
      "-": TokenType.Minus,
      "*": TokenType.Star,
      "/": TokenType.Slash,
      "%": TokenType.Percent,
      "=": TokenType.Assign,
      "<": TokenType.Lt,
      ">": TokenType.Gt,
      "!": TokenType.Not,
    };
    if (oneCharMap[c]) {
      advance();
      push(oneCharMap[c], c, startLine, startCol);
      continue;
    }

    throw new LexError(`Unexpected character '${c}' in ${fileName}`, startLine, startCol);
  }

  tokens.push({ type: TokenType.EOF, value: "", line, column });
  return tokens;
}
