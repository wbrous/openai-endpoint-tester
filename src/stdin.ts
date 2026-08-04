// Serializes stdin prompts across concurrent HTTP requests: only one prompt
// is on-screen and readable at a time, queued behind any prompt in flight.
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });

let queueTail: Promise<void> = Promise.resolve();

export interface StdinPromptRequest {
  model: string;
  endpoint: string;
  lastUserMessage: string;
}

/**
 * Precondition: process.stdin is a TTY or piped stream that stays open for
 * the server's lifetime.
 * Postcondition: resolves with operator-typed reply text once this prompt's
 * turn in the FIFO queue is reached; concurrent callers never interleave
 * their reads.
 */
export async function promptForCompletion(req: StdinPromptRequest): Promise<string> {
  const myTurn = queueTail;
  const { promise: nextTail, resolve: releaseNext } = Promise.withResolvers<void>();
  queueTail = nextTail;
  await myTurn;
  try {
    console.log("\n" + "─".repeat(60));
    console.log(`[${req.endpoint}] model=${req.model}`);
    console.log(`user: ${req.lastUserMessage.slice(0, 500)}`);
    console.log('Type the assistant reply. End with a line containing only "."');
    console.log('(empty first line + immediate "." = empty reply)');

    const lines: string[] = [];
    for (;;) {
      const line = await rl.question(lines.length === 0 ? "> " : ". > ");
      if (line === ".") break;
      lines.push(line);
    }
    return lines.join("\n");
  } finally {
    releaseNext();
  }
}

export function closeStdinPrompt(): void {
  rl.close();
}
