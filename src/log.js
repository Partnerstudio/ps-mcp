// Logs go to stderr only. stdout carries JSON-RPC and nothing else.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.PS_MCP_LOG_LEVEL] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] > threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
};
