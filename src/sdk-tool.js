// The `sdk` entry type: tools implemented in code rather than as an argv
// template. Argument binding and result shaping match the exec runner, so a
// path param behaves identically whichever kind of tool consumes it.
import { ToolInputError, bindArgs } from './args.js';
import { workRoot } from './paths.js';
import { jsonResult, textResult } from './result.js';
import { log } from './log.js';

function describeError(err) {
  const status = err.$metadata?.httpStatusCode;
  const name = err.name || 'Error';
  return status ? `${name} (HTTP ${status}): ${err.message}` : `${name}: ${err.message}`;
}

export async function runSdkTool(tool, args, { root = workRoot(), handlers }) {
  const handler = handlers[tool.name];
  if (!handler) throw new Error(`no sdk handler registered for \`${tool.name}\``);

  let values;
  try {
    values = bindArgs(tool, args, { root });
  } catch (err) {
    if (err instanceof ToolInputError) return textResult(err.message, true);
    throw err;
  }

  const started = Date.now();
  try {
    const result = await handler(values);
    log.info('sdk ok', { tool: tool.name, ms: Date.now() - started });
    return jsonResult(result);
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof ToolInputError) return textResult(err.message, true);
    log.warn('sdk failed', { tool: tool.name, ms, error: err.name });
    return textResult(describeError(err), true);
  }
}
