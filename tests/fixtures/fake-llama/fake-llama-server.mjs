#!/usr/bin/env node
import { createServer } from 'node:http';

/**
 * Fake llama.cpp `llama-server` for LocalModelManager tests.
 *
 * Speaks just enough of the real server's surface: GET /health and POST
 * /v1/chat/completions with OpenAI-compatible bodies. Scenarios are passed
 * through `--scenario=<name>` (which the real manager forwards verbatim from
 * `extraArgs`), so every failure mode is reproducible offline:
 *
 *   ok               healthy after ~100 ms; answers valid role JSON
 *   slow-health      healthy after ~1.2 s
 *   never-healthy    /health answers 503 forever
 *   exit-early       process exits(7) ~150 ms after start
 *   die-on-infer     healthy, then exits(9) upon the first inference request
 *   invalid-output   healthy; answers prose instead of JSON
 *   schema-unsupported  rejects json_schema bodies with HTTP 400, accepts json_object
 *
 * The response for a valid inference is selected by the requested schema
 * name (the manager's client sends the role name), so contract tests get
 * role-appropriate documents.
 */

const args = process.argv.slice(2);
function flagValue(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

const host = flagValue('--host') ?? '127.0.0.1';
const port = Number.parseInt(flagValue('--port') ?? '0', 10);
const scenario = flagValue('--scenario') ?? 'ok';

// The manager must always pass loopback; a fake that silently listened
// elsewhere would mask a binding regression, so refuse anything else.
if (host !== '127.0.0.1') {
  process.stderr.write(`fake-llama-server: refusing non-loopback host ${host}\n`);
  process.exit(2);
}

process.stdout.write(`fake-llama-server starting scenario=${scenario} port=${port}\n`);

if (scenario === 'exit-early') {
  setTimeout(() => {
    process.stderr.write('fake-llama-server: simulated startup crash\n');
    process.exit(7);
  }, 150);
}

const startedAt = Date.now();
const healthyAfterMs = scenario === 'slow-health' ? 1200 : 100;

const ROLE_RESPONSES = {
  CLASSIFIER: { complexity: 'MEDIUM', reasons: ['several requirements referenced'] },
  PLANNER: {
    decision: 'PLAN',
    goal: 'Implement the approved task.',
    steps: [
      { id: '1', action: 'Inspect the existing module layout.' },
      { id: '2', action: 'Implement the change behind the existing interface.' },
      { id: '3', action: 'Add unit tests for both paths.' },
    ],
    testStrategy: 'Unit tests for success and failure paths.',
    verificationStrategy: 'Run the configured trusted verification commands.',
    assumptions: [],
    risks: [],
    requiresEscalation: false,
  },
  CRITIC: { verdict: 'ACCEPT', reasons: ['steps are concrete, ordered, and verifiable'] },
  DIAGNOSER: {
    category: 'IMPLEMENTATION_DEFECT',
    rootCause: 'The save path drops the payload before persistence.',
    planValidity: 'VALID',
    recommendedAction: 'REPAIR',
    evidence: ['settings.test failed: expected persisted value'],
  },
  REPLANNER: {
    decision: 'REVISED_PLAN',
    reason: 'The assumed abstraction is absent; introduce it first.',
    goal: 'Introduce the abstraction, then implement the task.',
    steps: [
      { id: '1', action: 'Add the internal abstraction.' },
      { id: '2', action: 'Implement the task against it.' },
    ],
    assumptions: [],
    impactsApprovedIntent: false,
  },
  // Objective-runtime reasoning roles (v-next): the local tier may evaluate
  // and, when routed, decompose or aggregate.
  DECOMPOSER: {
    decision: 'SINGLE_UNIT',
    reason: 'The objective is cohesive enough to implement as one unit.',
    units: [],
  },
  EVALUATOR: {
    verdict: 'PASS',
    reasons: ['the candidate satisfies the projected contracts'],
    evidenceRefs: [],
    affectedContractIds: [],
  },
  AGGREGATOR: {
    synthesis: 'The reports agree; no conflicts detected.',
    findings: [],
    contractChangeSuggestions: [],
    conflictsDetected: [],
  },
};

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = request.url ?? '';
    if (url === '/health') {
      const healthy =
        scenario !== 'never-healthy' &&
        scenario !== 'exit-early' &&
        Date.now() - startedAt >= healthyAfterMs;
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'loading model' }));
      return;
    }
    if (/\/chat\/completions(\?|$)/.test(url)) {
      if (scenario === 'die-on-infer') {
        process.stderr.write('fake-llama-server: simulated crash during inference\n');
        process.exit(9);
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // keep {}
      }
      const format = body.response_format ?? {};
      if (scenario === 'schema-unsupported' && format.type === 'json_schema') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'response_format json_schema is not supported' } }),
        );
        return;
      }
      const schemaName = format.json_schema?.name ?? 'PLANNER';
      // `empty-plan`: SCHEMA-VALID output that plans nothing. A PLAN
      // decision with zero steps passes contract validation and is still not
      // a plan — the StepRelay dogfood's local model produced exactly this
      // and killed the driver, which the supervisor restarted straight back
      // into the same wall.
      const emptyPlan =
        scenario === 'empty-plan' && (schemaName === 'PLANNER' || schemaName === 'REPLANNER');
      const content = emptyPlan
        ? JSON.stringify({ ...ROLE_RESPONSES[schemaName], goal: undefined, steps: [] })
        : scenario === 'invalid-output'
          ? 'I think the plan should be: first we look around, then we code!'
          : JSON.stringify(ROLE_RESPONSES[schemaName] ?? ROLE_RESPONSES.PLANNER);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-fake-llama',
          object: 'chat.completion',
          model: 'fake-gguf',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 60 },
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
});

server.listen(port, host, () => {
  process.stdout.write(`fake-llama-server listening on ${host}:${port}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
});
