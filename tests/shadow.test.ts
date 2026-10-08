import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { childEnv } from '../src/claude/env.ts';
import { PROJECT_ROOT, parseMode } from '../src/config.ts';
import { GATEWAY_AUTH_HEADER, JevGateway } from '../src/gateway/server.ts';
import type { Message } from '../src/gateway/transcript.ts';
import { neutralAnswers, parseAnswers, type JevLike, type JevQuestion, type JevResult } from '../src/jev/client.ts';

const TOKEN = 'test-gateway-token';
const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
const u = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (id: string, command: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] });
const r = (id: string, content: string, is_error = false): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] });

function scriptedJev(script: Array<Record<string, unknown>>): JevLike & { calls: number } {
  const jev = {
    enabled: true,
    calls: 0,
    async ask(_state: string, questions: Record<string, JevQuestion>): Promise<JevResult> {
      jev.calls++;
      const raw = script.shift();
      return raw
        ? { answers: parseAnswers(raw, questions), failed: false, latencyMs: 1, inputTokens: 10 }
        : { answers: neutralAnswers(questions), failed: true, error: 'exhausted', latencyMs: 0, inputTokens: 0 };
    },
  };
  return jev;
}

/** Records the exact bytes of each request body. */
async function rawUpstream(): Promise<{ url: string; raw: string[]; headers: http.IncomingHttpHeaders[]; close: () => void }> {
  const raw: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      raw.push(body);
      headers.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, raw, headers, close: () => srv.close() };
}

async function post(base: string, body: string): Promise<void> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'x-claude-code-session-id': 'sess-shadow', authorization: 'Bearer secret', [GATEWAY_AUTH_HEADER]: TOKEN },
    body,
  });
  await res.text();
}

const HARD_TASK = { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 3.8 }, stakes: { noul: 0.1 } };
const HARD_STEP = { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.8 }, stuck: { noul: 0.1 } };

function journaledLines(dir: string): Array<Record<string, unknown>> {
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}

test('shadow: Jev is asked and journaled, the request is forwarded byte-identical', async () => {
  const up = await rawUpstream();
  const jev = scriptedJev([HARD_TASK, HARD_STEP]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shadow-'));
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, authToken: TOKEN, shadow: true });
  const base = await gw.listen();
  try {
    // Odd spacing and key order: only an untouched body survives a byte comparison.
    const m1 = [u('the date test fails, fix it')];
    const body1 = `{ "model":"claude-opus-5-5", "stream":true, "tools":${JSON.stringify(tools)}, "output_config":{"effort":"low"}, "messages":${JSON.stringify(m1)} }`;
    await post(base, body1);
    const m2 = [...m1, a('t1', 'npm test'), r('t1', 'Exit code 1: 2 failing', true)];
    const body2 = `{"messages":${JSON.stringify(m2)},"model":"claude-opus-5-5","tools":${JSON.stringify(tools)}}`;
    await post(base, body2);

    assert.deepEqual(up.raw, [body1, body2], 'bodies forwarded as received');
    assert.equal(up.headers[0]!['anthropic-beta'], 'oauth-2025-04-20', 'no per-message-effort beta added');
    assert.equal(jev.calls, 2, 'Jev still decides, on a model that is not the jev/ alias');

    const lines = journaledLines(dir);
    const prepared = lines.filter((l) => l.status === 'prepared');
    assert.equal(prepared.length, 2, 'both decisions journaled');
    for (const rec of prepared) assert.deepEqual(rec.insertions, [], 'no phantom statement recorded for replay');
    assert.equal((prepared[1]!.decision as { effort: string }).effort, 'high', 'the decision itself is recorded');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow: a jev/ model alias is rewritten but nothing else changes', async () => {
  const up = await rawUpstream();
  const gw = new JevGateway({ jev: scriptedJev([HARD_TASK]), bounds: { min: 'low', max: 'high' }, upstream: up.url, authToken: TOKEN, shadow: true });
  const base = await gw.listen();
  try {
    const messages = [u('fix it')];
    await post(base, JSON.stringify({ model: 'jev/claude-opus-5-5', tools, messages }));
    assert.deepEqual(JSON.parse(up.raw[0]!), { model: 'claude-opus-5-5', tools, messages });
  } finally {
    await gw.close();
    up.close();
  }
});

test('active mode (default) still inserts the statement for the same request', async () => {
  const up = await rawUpstream();
  const gw = new JevGateway({ jev: scriptedJev([HARD_TASK]), bounds: { min: 'low', max: 'high' }, upstream: up.url, authToken: TOKEN });
  const base = await gw.listen();
  try {
    await post(base, JSON.stringify({ model: 'jev/claude-opus-5-5', tools, messages: [u('fix it')] }));
    const sent = JSON.parse(up.raw[0]!).messages as Message[];
    assert.equal(sent[0]!.role, 'system');
  } finally {
    await gw.close();
    up.close();
  }
});

test('active: bounds from the default config cap a hard task at high, never max', async () => {
  const up = await rawUpstream();
  const gw = new JevGateway({ jev: scriptedJev([{ ...HARD_TASK, stakes: { noul: 0.99 } }]), bounds: { min: 'low', max: 'high' }, upstream: up.url, authToken: TOKEN });
  const base = await gw.listen();
  try {
    await post(base, JSON.stringify({ model: 'jev/claude-opus-5-5', tools, messages: [u('redesign the whole architecture')] }));
    const first = (JSON.parse(up.raw[0]!).messages as Array<{ output_config?: { effort: string } }>)[0]!;
    assert.equal(first.output_config?.effort, 'high');
  } finally {
    await gw.close();
    up.close();
  }
});

test('JEV_OPUS_MODE parsing rejects typos instead of silently going active', () => {
  assert.equal(parseMode(undefined), 'active');
  assert.equal(parseMode(''), 'active');
  assert.equal(parseMode('active'), 'active');
  assert.equal(parseMode('Shadow'), 'shadow');
  assert.equal(parseMode('shaddow'), null);
});

test('config: max effort defaults to high and only JEV_OPUS_MAX_EFFORT raises it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-opus-cfg-'));
  const url = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'config.ts')).href;
  const code = `const { config } = await import(${JSON.stringify(url)}); console.log(config.maxEffort);`;
  const run = (extra: Record<string, string>) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), JEV_OPUS_CONFIG_DIR: tmp, ...extra },
    }).trim();
  try {
    assert.equal(run({}), 'high');
    assert.equal(run({ JEV_OPUS_MAX_EFFORT: 'bogus' }), 'high');
    assert.equal(run({ JEV_OPUS_MAX_EFFORT: 'max' }), 'max');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('childEnv passthrough keeps CLAUDE_CODE_*, OTEL_* and MCP_* and drops only what bypasses the gateway', () => {
  const NO = { value: '', source: '' };
  const { env } = childEnv(
    {
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
      CLAUDE_CODE_THISTLE_GREBE: 'default',
      CLAUDE_CONFIG_DIR: '/cfg',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel',
      MCP_TIMEOUT: '30',
      ANTHROPIC_MODEL: 'claude-opus-5-5',
      TYPESAFE_API_KEY: 'router-secret',
      ANTHROPIC_API_KEY: 'sk-parent',
      ANTHROPIC_AUTH_TOKEN: 'at-parent',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok-parent',
      ANTHROPIC_BASE_URL: 'https://parent',
      ANTHROPIC_CUSTOM_HEADERS: 'x: y',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDECODE: '1',
      PATH: '/bin',
    },
    { passthrough: true, credentials: { apiKey: NO, oauthToken: NO, authToken: NO, baseUrl: NO } },
  );
  assert.equal(env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
  assert.equal(env.CLAUDE_CODE_THISTLE_GREBE, 'default');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://otel');
  assert.equal(env.MCP_TIMEOUT, '30');
  assert.equal(env.ANTHROPIC_MODEL, 'claude-opus-5-5');
  assert.equal(env.PATH, '/bin');
  for (const name of ['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDECODE']) {
    assert.equal(env[name], undefined, `${name} must not reach the child`);
  }
});

test('childEnv without passthrough still strips every ANTHROPIC_*, CLAUDE*, MCP_* and OTEL_* variable', () => {
  const NO = { value: '', source: '' };
  const { env } = childEnv({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', OTEL_X: '1', MCP_X: '1', ANTHROPIC_MODEL: 'm', PATH: '/bin' }, { credentials: { apiKey: NO, oauthToken: NO, authToken: NO, baseUrl: NO } });
  assert.deepEqual(Object.keys(env).filter((k) => k !== 'ENABLE_CLAUDEAI_MCP_SERVERS').sort(), ['PATH']);
});

test('childEnv passthrough keeps CLAUDE_CODE_EFFORT_LEVEL in shadow mode only', () => {
  const NO = { value: '', source: '' };
  const credentials = { apiKey: NO, oauthToken: NO, authToken: NO, baseUrl: NO };
  const base = { CLAUDE_CODE_EFFORT_LEVEL: 'low', PATH: '/bin' };
  assert.equal(childEnv(base, { passthrough: true, shadow: true, credentials }).env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(childEnv(base, { passthrough: true, shadow: false, credentials }).env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(childEnv(base, { passthrough: true, credentials }).env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
});
