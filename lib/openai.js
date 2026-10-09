'use strict';
/**
 * OpenAI Chat Completions helpers (Structured Outputs / JSON Schema).
 * The HTTP call itself is done by an n8n HTTP Request node that uses the
 * "OpenAI (Offshore Fares)" credential – no key ever appears in code.
 */
const { supportsTemperature } = require('./config');
const { containsSecret } = require('./security');

function buildChatRequest({ model, system, user, schema, schemaName, temperature, maxTokens }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName || 'result', strict: true, schema },
    },
  };
  if (supportsTemperature(model)) body.temperature = typeof temperature === 'number' ? temperature : 0;
  if (maxTokens) body.max_completion_tokens = maxTokens;
  return body;
}

/**
 * Parse an HTTP Request node output (success or `{ error }` when the node is set
 * to continue on fail). Returns { ok, data, error, usage, model }.
 */
function parseChatResponse(item) {
  const json = item || {};
  if (json.error) {
    const err = json.error;
    const message = typeof err === 'string' ? err : err.message || err.description || 'OpenAI request failed';
    return { ok: false, data: null, error: `OPENAI_HTTP_ERROR: ${String(message).slice(0, 300)}` };
  }
  const choice = json.choices && json.choices[0];
  if (!choice || !choice.message) return { ok: false, data: null, error: 'OPENAI_EMPTY_RESPONSE' };
  if (choice.message.refusal) return { ok: false, data: null, error: `OPENAI_REFUSAL: ${String(choice.message.refusal).slice(0, 200)}` };
  if (choice.finish_reason === 'length') return { ok: false, data: null, error: 'OPENAI_TRUNCATED' };
  const content = choice.message.content;
  let data;
  try {
    data = typeof content === 'string' ? JSON.parse(content) : content;
  } catch (e) {
    return { ok: false, data: null, error: 'OPENAI_INVALID_JSON' };
  }
  if (!data || typeof data !== 'object') return { ok: false, data: null, error: 'OPENAI_INVALID_JSON' };
  if (containsSecret(JSON.stringify(data))) return { ok: false, data: null, error: 'OPENAI_OUTPUT_CONTAINS_SECRET_PATTERN' };
  return { ok: true, data, error: null, usage: json.usage || null, model: json.model || null };
}

/** Helpers to declare strict JSON-schema fields compactly. */
const S = {
  str: () => ({ type: 'string' }),
  nstr: () => ({ type: ['string', 'null'] }),
  int: () => ({ type: 'integer' }),
  nint: () => ({ type: ['integer', 'null'] }),
  num: () => ({ type: 'number' }),
  nnum: () => ({ type: ['number', 'null'] }),
  bool: () => ({ type: 'boolean' }),
  nbool: () => ({ type: ['boolean', 'null'] }),
  enumOf: (values, nullable) => (nullable ? { type: ['string', 'null'], enum: values.concat([null]) } : { type: 'string', enum: values }),
  arr: (items) => ({ type: 'array', items }),
  obj: (properties, nullable) => ({
    type: nullable ? ['object', 'null'] : 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
};

module.exports = { buildChatRequest, parseChatResponse, S };
