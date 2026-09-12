export enum TokenType {
  // literals
  IntLiteral = "IntLiteral",
  FloatLiteral = "FloatLiteral",
  StringLiteral = "StringLiteral",
  BoolLiteral = "BoolLiteral",
  Identifier = "Identifier",

  // keywords
  Public = "Public",
  Private = "Private",
  Function = "Function",
  Let = "Let",
  Const = "Const",
  Return = "Return",
  If = "If",
  Else = "Else",
  While = "While",
  For = "For",
  Import = "Import",
  From = "From",
  Export = "Export",
  Break = "Break",
  Continue = "Continue",
  True = "True",
  False = "False",
  New = "New",
  Struct = "Struct",
  Switch = "Switch",
  Case = "Case",
  Default = "Default",
  Do = "Do",
  Null = "Null",
  TypeOf = "TypeOf",
  // a backtick string, kept as the raw text between the backticks. The parser
  // is what pulls ${...} out of it, because only a parser can nest properly.
  Template = "Template",

  // types (kept as identifiers too, but reserved for clarity in the parser)
  TypeKeyword = "TypeKeyword",

  // punctuation
  Colon = "Colon",
  Semicolon = "Semicolon",
  Comma = "Comma",
  Dot = "Dot",
  LParen = "LParen",
  RParen = "RParen",
  LBrace = "LBrace",
  RBrace = "RBrace",
  LBracket = "LBracket",
  RBracket = "RBracket",
  Arrow = "Arrow",
  // @ starts a compiler directive, e.g. @modules.import("json")
  At = "At",

  // operators
  Plus = "Plus",
  Minus = "Minus",
  Star = "Star",
  Slash = "Slash",
  Percent = "Percent",
  Assign = "Assign",
  PlusAssign = "PlusAssign",
  MinusAssign = "MinusAssign",
  StarAssign = "StarAssign",
  SlashAssign = "SlashAssign",
  Eq = "Eq",
  NotEq = "NotEq",
  Lt = "Lt",
  Gt = "Gt",
  LtEq = "LtEq",
  GtEq = "GtEq",
  And = "And",
  Or = "Or",
  Not = "Not",
  Increment = "Increment",
  Decrement = "Decrement",
  PercentAssign = "PercentAssign",
  Amp = "Amp",
  Pipe = "Pipe",
  Caret = "Caret",
  Tilde = "Tilde",
  Shl = "Shl",
  Shr = "Shr",
  AmpAssign = "AmpAssign",
  PipeAssign = "PipeAssign",
  CaretAssign = "CaretAssign",
  ShlAssign = "ShlAssign",
  ShrAssign = "ShrAssign",
  EqEqEq = "EqEqEq",
  NotEqEq = "NotEqEq",
  Question = "Question",

  // comments. Only ever produced when the lexer is asked to keep them, which
  // today means one caller: `yare fmt`, who promises not to lose your notes.
  LineComment = "LineComment",
  BlockComment = "BlockComment",

  // misc
  EOF = "EOF",
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export const KEYWORDS: Record<string, TokenType> = {
  public: TokenType.Public,
  private: TokenType.Private,
  function: TokenType.Function,
  let: TokenType.Let,
  const: TokenType.Const,
  return: TokenType.Return,
  if: TokenType.If,
  else: TokenType.Else,
  while: TokenType.While,
  for: TokenType.For,
  import: TokenType.Import,
  from: TokenType.From,
  export: TokenType.Export,
  break: TokenType.Break,
  continue: TokenType.Continue,
  true: TokenType.True,
  false: TokenType.False,
  new: TokenType.New,
  struct: TokenType.Struct,
  switch: TokenType.Switch,
  case: TokenType.Case,
  default: TokenType.Default,
  do: TokenType.Do,
  null: TokenType.Null,
  typeof: TokenType.TypeOf,
};

// Primitive yarescript types. Kept separate from KEYWORDS so that identifiers
// like a variable named `int_count` still lex fine. The real gatekeeper for
// type names is the checker; this list is here so editors have something to
// highlight.
export const PRIMITIVE_TYPES = new Set([
  "void",
  "bool",
  "string",
  "i8",
  "i16",
  "char",
  "int",
  "long",
  "u8",
  "u16",
  "u32",
  "u64",
  "float",
  "double",
]);
