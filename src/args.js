// Validates and binds tool arguments. Shared by the exec and sdk runners.
//
// Clients are told the inputSchema, but the arguments arrive from a model and
// the schema is a hint to it, not a guarantee -- so everything is re-checked.
// Params marked `path: true` come back canonicalised and proven to sit inside
// the work root.
import { PathDenied, resolveWorkPath } from './paths.js';

export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

function checkType(param, value) {
  switch (param.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return param.values.includes(value);
    default:
      return false;
  }
}

// Returns a plain object of typed values. Absent optional params are simply not
// present, which is what lets an exec argv token be dropped whole.
export function bindArgs(tool, args = {}, { root } = {}) {
  const supplied = args && typeof args === 'object' ? args : {};
  const known = new Set(tool.params.map((p) => p.name));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) throw new ToolInputError(`unknown argument \`${key}\``);
  }

  const values = {};
  for (const param of tool.params) {
    let value = supplied[param.name];
    if (value === undefined || value === null) value = param.default;
    if (value === undefined || value === null) {
      if (param.required) throw new ToolInputError(`missing required argument \`${param.name}\``);
      continue;
    }
    if (!checkType(param, value)) {
      const expected = param.type === 'enum' ? `one of ${param.values.join(', ')}` : param.type;
      throw new ToolInputError(`argument \`${param.name}\` must be ${expected}`);
    }
    if (param.path) {
      try {
        value = resolveWorkPath(value, root ? { root } : undefined);
      } catch (err) {
        if (err instanceof PathDenied) {
          throw new ToolInputError(`argument \`${param.name}\`: ${err.message}`);
        }
        throw err;
      }
    }
    values[param.name] = value;
  }
  return values;
}
