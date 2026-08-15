export const TOOL_RESULT_KEEP_FULL = 4;
export const TOOL_RESULT_MAX_CHARS = 3_500;
export const TOOL_RESULT_STALE_CHARS = 1_200;

export function truncateToolOutput(output: unknown, maxChars: number): unknown {
  if (typeof output === 'string') {
    if (output.length <= maxChars) return output;
    return `${output.slice(0, maxChars)}\n…[truncated for speed]`;
  }
  if (output == null) return output;
  try {
    const raw = JSON.stringify(output);
    if (raw.length <= maxChars) return output;
    return `${raw.slice(0, maxChars)}…[truncated for speed]`;
  } catch {
    return output;
  }
}

function isToolMessage(message: any): boolean {
  if (message?.role === 'tool') return true;
  return Array.isArray(message?.content) && message.content.some((p: any) => p?.type === 'tool-result');
}

function toolFingerprint(message: any): string {
  try {
    const parts = Array.isArray(message?.content) ? message.content : [];
    const result = parts.find((p: any) => p?.type === 'tool-result');
    const name = result?.toolName || result?.name || '';
    const out = typeof result?.output === 'string' ? result.output.slice(0, 180) : JSON.stringify(result?.output || '').slice(0, 180);
    return `${name}:${out}`;
  } catch {
    return '';
  }
}

/**
 * Shrink older / duplicate tool results in the provider request only.
 * Conversation state in the agent remains intact.
 */
export function compactMessagesForTurn(context: {
  iteration: number;
  messages: readonly any[];
}): { messages: any[] } | undefined {
  if (!Array.isArray(context.messages) || context.messages.length < 6) {
    return undefined;
  }
  const toolMsgIndexes: number[] = [];
  for (let i = 0; i < context.messages.length; i++) {
    if (isToolMessage(context.messages[i])) toolMsgIndexes.push(i);
  }
  if (toolMsgIndexes.length <= TOOL_RESULT_KEEP_FULL && context.iteration < 2) {
    return undefined;
  }
  const keepFull = new Set(toolMsgIndexes.slice(-TOOL_RESULT_KEEP_FULL));
  const seen = new Set<string>();
  const messages = context.messages.map((msg, idx) => {
    if (!isToolMessage(msg)) return msg;
    const fp = toolFingerprint(msg);
    const duplicate = fp && seen.has(fp);
    if (fp) seen.add(fp);
    const maxChars = keepFull.has(idx) && !duplicate ? TOOL_RESULT_MAX_CHARS : TOOL_RESULT_STALE_CHARS;
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((part: any) => {
        if (part?.type !== 'tool-result') return part;
        if (duplicate) {
          return {
            ...part,
            output: '[duplicate of earlier tool result — already in context; do not re-read]',
          };
        }
        return {
          ...part,
          output: truncateToolOutput(part.output, maxChars),
        };
      }),
    };
  });
  return { messages };
}
