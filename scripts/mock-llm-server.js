#!/usr/bin/env node
// Mock OpenAI-compatible LLM server for staging & testing.
// Listens on :8080, accepts POST /v1/chat/completions,
// returns configurable responses with simulated latency.

const http = require('http');
const { URL } = require('url');

const PORT = parseInt(process.env.MOCK_LLM_PORT || '8080', 10);
const SIMULATED_LATENCY_MS = parseInt(process.env.MOCK_LLM_LATENCY || '200', 10);
const LATENCY_JITTER_MS = parseInt(process.env.MOCK_LLM_LATENCY_JITTER || '100', 10);
const ERROR_RATE = parseFloat(process.env.MOCK_LLM_ERROR_RATE || '0');
const ERROR_STATUS = parseInt(process.env.MOCK_LLM_ERROR_STATUS || '429', 10);

const log = (level, msg, meta) => {
  const entry = { time: new Date().toISOString(), level, msg, ...meta };
  console.log(JSON.stringify(entry));
};

function latency() {
  const jitter = Math.random() * LATENCY_JITTER_MS * 2 - LATENCY_JITTER_MS;
  return Math.max(0, SIMULATED_LATENCY_MS + jitter);
}

function simulateDelay() {
  return new Promise((resolve) => setTimeout(resolve, latency()));
}

function isError() {
  if (ERROR_RATE <= 0) return false;
  return Math.random() < ERROR_RATE;
}

function buildResponse(body) {
  const model = body.model || 'mock-gpt-4o-mini';
  const messages = body.messages || [];
  const tools = body.tools || [];

  const lastMsg = messages[messages.length - 1];
  const userContent = lastMsg?.content || 'Hello';

  const finishReason = tools.length > 0 && userContent.toLowerCase().includes('tool') ? 'tool_calls' : 'stop';

  const response = {
    id: `chatcmpl-mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: {
          role: 'assistant',
          content: finishReason === 'stop'
            ? `Mock response to: "${userContent.slice(0, 80)}"`
            : null,
        },
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
      completion_tokens: 50,
      total_tokens: Math.ceil(JSON.stringify(messages).length / 4) + 50,
    },
  };

  if (finishReason === 'tool_calls') {
    response.choices[0].message.tool_calls = [
      {
        id: `call-mock-${Date.now()}`,
        type: 'function',
        function: {
          name: tools[0]?.function?.name || 'mock_tool',
          arguments: JSON.stringify({ path: '/tmp/test.txt', content: 'mock content' }),
        },
      },
    ];
  }

  return response;
}

function handleChatCompletions(req, body) {
  log('info', 'chat completion request', {
    model: body.model,
    messages: body.messages?.length,
    tools: body.tools?.length,
  });

  if (isError()) {
    log('warn', 'simulating error', { status: ERROR_STATUS });
    return { status: ERROR_STATUS, body: { error: { message: 'Mock simulated error', type: 'mock_error' } } };
  }

  return { status: 200, body: buildResponse(body) };
}

function handleModels() {
  return {
    status: 200,
    body: {
      object: 'list',
      data: [
        { id: 'gpt-4o', object: 'model' },
        { id: 'gpt-4o-mini', object: 'model' },
        { id: 'gpt-3.5-turbo', object: 'model' },
        { id: 'mock-gpt-4o-mini', object: 'model' },
      ],
    },
  };
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const path = parsed.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health
  if (path === '/health' || path === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', mock: true }));
    return;
  }

  // Model list
  if (path === '/v1/models' && method === 'GET') {
    const result = handleModels();
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
    return;
  }

  // Chat completions
  if (path === '/v1/chat/completions' && method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        await simulateDelay();
        const result = handleChatCompletions(req, parsed);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        log('error', 'failed to parse request body', { error: err.message });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      }
    });
    return;
  }

  // Catch-all
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Not found: ${method} ${path}` } }));
});

server.listen(PORT, '0.0.0.0', () => {
  const host = `http://0.0.0.0:${PORT}`;
  console.log('='.repeat(60));
  console.log(`  Mock LLM Server running at ${host}`);
  console.log(`  Simulated latency: ${SIMULATED_LATENCY_MS}ms +/- ${LATENCY_JITTER_MS}ms`);
  console.log(`  Error rate: ${(ERROR_RATE * 100).toFixed(1)}%`);
  console.log(`  Endpoints:`);
  console.log(`    POST ${host}/v1/chat/completions`);
  console.log(`    GET  ${host}/v1/models`);
  console.log(`    GET  ${host}/health`);
  console.log('='.repeat(60));
});
