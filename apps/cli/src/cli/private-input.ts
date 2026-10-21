export async function readRecoverySecret(): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  const input = process.stdin;
  const terminal = process.stderr;
  let value = "";
  input.setRawMode(true);
  terminal.write("Recovery secret (hidden): ");
  try {
    return await new Promise<string>((resolve, reject) => {
      const received = (chunk: Buffer) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\r" || character === "\n") {
            input.off("data", received);
            resolve(value);
            return;
          }
          if (character === "\u0003") {
            input.off("data", received);
            reject(new Error("Recovery input was cancelled"));
            return;
          }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (/^[A-Za-z0-9_-]$/.test(character) && value.length < 128) value += character;
        }
      };
      input.on("data", received);
      input.resume();
    });
  } finally {
    input.setRawMode(false);
    terminal.write("\n");
  }
}
