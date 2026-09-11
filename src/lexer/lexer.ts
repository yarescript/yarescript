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
 * Comments (// ...) are discarded, not emitted as tokens.
 */
export function tokenize(source: string, fileName = "<source>"): Token[] {
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

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    // line comments
    if (c === "/" && peek(1) === "/") {
      while (i < source.length && peek() !== "\n") advance();
      continue;
    }

    // block comments
    if (c === "/" && peek(1) === "*") {
      advance();
      advance();
      while (i < source.length && !(peek() === "*" && peek(1) === "/")) advance();
      advance();
      advance();
      continue;
    }

    // strings
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

    // numbers
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

    // identifiers / keywords
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

    // two-char operators
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
