// MCP tool results. Shared by the exec and sdk runners.
const MAX_TEXT = 256 * 1024;

export function clamp(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n\n[truncated: ${text.length} bytes total]`;
}

export function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

export function jsonResult(value) {
  return textResult(clamp(JSON.stringify(value, null, 2)));
}
