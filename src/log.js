// Logs go to stderr only. stdout carries JSON-RPC and nothing else.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Read per call, not at import: imports run before any caller's code, so a
// threshold fixed at load could never be lowered by `ps-mcp doctor`.
function emit(level, msg, fields) {
  if (LEVELS[level] > (LEVELS[process.env.PS_MCP_LOG_LEVEL] ?? LEVELS.info)) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
};
