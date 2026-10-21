export function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let position = 0;

  function whitespace(): void {
    while (/^[\u0009\u000a\u000d\u0020]$/.test(source[position] ?? "")) position += 1;
  }

  function string(): string {
    const start = position;
    if (source[position] !== '"') throw new Error("Expected JSON string");
    position += 1;
    while (position < source.length) {
      const character = source[position];
      if (character === '"') {
        position += 1;
        return JSON.parse(source.slice(start, position)) as string;
      }
      if (character === "\\") {
        position += 2;
      } else {
        position += 1;
      }
    }
    throw new Error("Unterminated JSON string");
  }

  function value(depth: number): unknown {
    if (depth > 32) throw new Error("JSON nesting is too deep");
    whitespace();
    const character = source[position];
    if (character === '"') return string();
    if (character === "{") return object(depth + 1);
    if (character === "[") return array(depth + 1);
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return result;
      }
    }
    const number = source.slice(position).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) throw new Error("Invalid JSON value");
    position += number[0].length;
    return Number(number[0]);
  }

  function object(depth: number): Record<string, unknown> {
    position += 1;
    whitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (source[position] === "}") {
      position += 1;
      return result;
    }
    while (true) {
      whitespace();
      const key = string();
      if (keys.has(key)) throw new Error(`Duplicate JSON member: ${key}`);
      keys.add(key);
      whitespace();
      if (source[position] !== ":") throw new Error("Expected colon after JSON member name");
      position += 1;
      Object.defineProperty(result, key, {
        value: value(depth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      whitespace();
      if (source[position] === "}") {
        position += 1;
        return result;
      }
      if (source[position] !== ",") throw new Error("Expected comma in JSON object");
      position += 1;
    }
  }

  function array(depth: number): unknown[] {
    position += 1;
    whitespace();
    const result: unknown[] = [];
    if (source[position] === "]") {
      position += 1;
      return result;
    }
    while (true) {
      result.push(value(depth));
      whitespace();
      if (source[position] === "]") {
        position += 1;
        return result;
      }
      if (source[position] !== ",") throw new Error("Expected comma in JSON array");
      position += 1;
    }
  }

  const result = value(0);
  whitespace();
  if (position !== source.length) throw new Error("Unexpected content after JSON value");
  return result;
}
