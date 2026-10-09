'use strict';
/**
 * Tiny builder for n8n workflow JSON.
 *
 * Why generated? The deterministic business logic lives in lib/ and is unit
 * tested with `node --test`. Code nodes embed exactly that code (bundled), and
 * the OpenAI system prompts are injected from prompts/*.md. Editing lib/ or a
 * prompt and re-running `npm run build` keeps tests, docs and n8n in sync.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// IDs / credentials
// ---------------------------------------------------------------------------
const WF = {
  WF01: { id: 'ofwf010000000001', name: 'WF01_EMAIL_INTAKE' },
  WF02: { id: 'ofwf020000000002', name: 'WF02_WHATSAPP_INTAKE' },
  WF03: { id: 'ofwf030000000003', name: 'WF03_INTENT_CLASSIFIER' },
  WF04: { id: 'ofwf040000000004', name: 'WF04_TRAVEL_REQUEST_EXTRACTOR' },
  WF05: { id: 'ofwf050000000005', name: 'WF05_MISSING_INFORMATION_HANDLER' },
  WF06: { id: 'ofwf060000000006', name: 'WF06_RFQ_MANAGER' },
  WF07: { id: 'ofwf070000000007', name: 'WF07_PRIORITY_ENGINE' },
  WF08: { id: 'ofwf080000000008', name: 'WF08_SLA_MONITOR' },
  WF09: { id: 'ofwf090000000009', name: 'WF09_FARE_DESK_ROUTER' },
  WF10: { id: 'ofwf100000000010', name: 'WF10_QUOTE_FORMATTER' },
  WF11: { id: 'ofwf110000000011', name: 'WF11_HUMAN_APPROVAL' },
  WF12: { id: 'ofwf120000000012', name: 'WF12_QUOTE_DELIVERY' },
  WF13: { id: 'ofwf130000000013', name: 'WF13_FOLLOWUP_ENGINE' },
  WF14: { id: 'ofwf140000000014', name: 'WF14_CLIENT_RESPONSE_HANDLER' },
  WF15: { id: 'ofwf150000000015', name: 'WF15_AFTER_SALES_ROUTER' },
  WF16: { id: 'ofwf160000000016', name: 'WF16_FARE_DESK_INTAKE' },
  WF17: { id: 'ofwf170000000017', name: 'WF17_OPERATOR_ACTIONS' },
  WF99: { id: 'ofwf990000000099', name: 'WF99_ERROR_HANDLER' },
};

const CRED = {
  postgres: { postgres: { id: 'ofPostgresCred01', name: 'Offshore Fares DB' } },
  openai: { openAiApi: { id: 'ofOpenAiCred0001', name: 'OpenAI (Offshore Fares)' } },
  opsToken: { httpHeaderAuth: { id: 'ofOpsTokenCred01', name: 'Ops Console Token' } },
  whatsapp: { httpHeaderAuth: { id: 'ofWhatsAppCred01', name: 'WhatsApp Cloud API' } },
  gmail: { gmailOAuth2: { id: 'ofGmailCred00001', name: 'Gmail (Offshore Fares)' } },
};

// ---------------------------------------------------------------------------
// Library bundling (mini CommonJS) for Code nodes
// ---------------------------------------------------------------------------
function collectModules(entries) {
  const seen = new Map();
  const visit = (rel) => {
    const key = rel.replace(/\\/g, '/').replace(/\.js$/, '');
    if (seen.has(key)) return;
    const file = path.join(ROOT, `${key}.js`);
    const src = fs.readFileSync(file, 'utf8');
    seen.set(key, src);
    for (const m of src.matchAll(/require\('(\.\/[^']+|\.\.\/[^']+)'\)/g)) {
      visit(path.posix.join(path.posix.dirname(key), m[1]));
    }
  };
  entries.forEach((e) => visit(`lib/${e}`));
  return seen;
}

function bundle(entries) {
  const modules = collectModules(entries);
  const defs = Array.from(modules.entries()).map(([key, src]) => {
    const body = src.replace(/^'use strict';\n/, '').replace(/^#!.*\n/, '');
    return `  ${JSON.stringify(key)}: function (module, exports, require) {\n${body}\n  }`;
  }).join(',\n');
  const exportsMap = entries.map((e) => `${JSON.stringify(e.split('/').pop())}: __req(${JSON.stringify(`lib/${e}`)})`).join(', ');
  return [
    '// ======================================================================',
    '// Shared library – GENERATED from lib/ by scripts/build-workflows.js.',
    '// Do not edit here: edit lib/*.js, run `npm test` and `npm run build`.',
    '// ======================================================================',
    'function __lib() {',
    '  const __defs = {',
    defs,
    '  };',
    '  const __cache = {};',
    '  function __resolve(from, req) {',
    "    const parts = from.split('/').slice(0, -1);",
    "    for (const seg of req.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }",
    "    return parts.join('/').replace(/\\.js$/, '');",
    '  }',
    '  function __req(key) {',
    '    if (__cache[key]) return __cache[key].exports;',
    '    const module = { exports: {} };',
    '    __cache[key] = module;',
    '    __defs[key](module, module.exports, (r) => __req(__resolve(key, r)));',
    '    return module.exports;',
    '  }',
    `  return { ${exportsMap} };`,
    '}',
  ].join('\n');
}

function readPrompt(file) {
  const src = fs.readFileSync(path.join(ROOT, 'prompts', file), 'utf8');
  const m = /<!-- BEGIN SYSTEM PROMPT -->\n([\s\S]*?)\n<!-- END SYSTEM PROMPT -->/.exec(src);
  if (!m) throw new Error(`No system prompt markers in prompts/${file}`);
  return m[1].trim();
}

// ---------------------------------------------------------------------------
// Workflow builder
// ---------------------------------------------------------------------------
class Workflow {
  constructor(key, { description, errorWorkflow = true } = {}) {
    this.meta = WF[key];
    this.nodes = [];
    this.connections = {};
    this.description = description;
    this.errorWorkflow = errorWorkflow;
    this.counter = 0;
  }

  add(node, pos) {
    if (this.nodes.some((n) => n.name === node.name)) throw new Error(`Duplicate node name "${node.name}" in ${this.meta.name}`);
    this.counter += 1;
    node.id = node.id || `${this.meta.id}-${String(this.counter).padStart(3, '0')}`;
    node.position = pos || [this.counter * 240, 0];
    this.nodes.push(node);
    return node.name;
  }

  /** connect(from, to, outputIndex = 0) */
  connect(from, to, output = 0) {
    this.connections[from] = this.connections[from] || { main: [] };
    const main = this.connections[from].main;
    while (main.length <= output) main.push([]);
    main[output].push({ node: to, type: 'main', index: 0 });
    return this;
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i += 1) this.connect(names[i], names[i + 1]);
    return this;
  }

  toJSON() {
    const settings = { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' };
    if (this.errorWorkflow) settings.errorWorkflow = WF.WF99.id;
    return {
      id: this.meta.id,
      name: this.meta.name,
      nodes: this.nodes,
      connections: this.connections,
      settings,
      pinData: {},
      active: false,
      meta: { templateCredsSetupCompleted: true },
      tags: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Node factories
// ---------------------------------------------------------------------------
const N = {
  sticky(name, content, { width = 420, height = 260, color = 7 } = {}) {
    return { name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: { content, width, height, color } };
  },

  code(name, logic, libs = [], extra = {}) {
    const header = `// ${name}\n// Logic below uses the shared library (OF.*) bundled at the end of this node.\nconst OF = __lib();\n`;
    const jsCode = `${header}${logic.trim()}\n\n${libs.length ? bundle(libs) : 'function __lib() { return {}; }'}\n`;
    return Object.assign({ name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode } }, extra);
  },

  /** Calls a PostgreSQL API function with $json[field] as its jsonb argument. */
  pg(name, fn, field = 'db', extra = {}) {
    return Object.assign({
      name,
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      parameters: {
        operation: 'executeQuery',
        query: `SELECT ${fn}($1::jsonb) AS r;`,
        options: { queryReplacement: `={{ [ JSON.stringify($json.${field} || {}) ] }}` },
      },
      credentials: CRED.postgres,
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 1000,
    }, extra);
  },

  webhook(name, method, pathName, { auth = true, responseMode = 'responseNode', rawBody = false } = {}) {
    const node = {
      name,
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      webhookId: `of-${pathName.replace(/[^a-z0-9]+/gi, '-')}-${method.toLowerCase()}`,
      parameters: { httpMethod: method, path: pathName, authentication: auth ? 'headerAuth' : 'none', responseMode, options: rawBody ? { rawBody: true } : {} },
    };
    if (auth) node.credentials = CRED.opsToken;
    return node;
  },

  respond(name, { body = '={{ JSON.stringify($json.response || $json) }}', code = '={{ $json.http_status || 200 }}', text = false } = {}) {
    return {
      name,
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      parameters: text
        ? { respondWith: 'text', responseBody: body, options: { responseCode: code } }
        : { respondWith: 'json', responseBody: body, options: { responseCode: code } },
    };
  },

  trigger(name = 'When Called By Another Workflow') {
    return { name, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, parameters: { inputSource: 'passthrough' } };
  },

  exec(name, key, { wait = true, each = false } = {}) {
    return {
      name,
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.2,
      parameters: {
        source: 'database',
        workflowId: { __rl: true, value: WF[key].id, mode: 'id', cachedResultName: WF[key].name },
        mode: each ? 'each' : 'once',
        options: { waitForSubWorkflow: wait },
      },
    };
  },

  schedule(name, minutes) {
    return {
      name,
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } },
    };
  },

  /** Switch on a string field; outputs named after values (in order). */
  switch(name, expression, values) {
    return {
      name,
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      parameters: {
        rules: {
          values: values.map((v) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
              conditions: [{ leftValue: expression, rightValue: v, operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: v,
          })),
        },
        options: {},
      },
    };
  },

  openai(name) {
    return {
      name,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'openAiApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.openai_request) }}',
        options: { timeout: 30000 },
      },
      credentials: CRED.openai,
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput',
    };
  },
};

module.exports = { WF, CRED, Workflow, N, bundle, readPrompt, ROOT };
