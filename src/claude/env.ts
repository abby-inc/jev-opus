import { config, type ClaudeCredentials } from '../config.ts';

/**
 * Environment for the Claude Code child process.
 *
 * A parent Claude Code session (CLI or desktop app) exports its own
 * ANTHROPIC_* / CLAUDE_* variables — its auth token, model aliases, and
 * CLAUDE_CODE_EFFORT_LEVEL, which would override every effort change we make.
 * None of that is ours to reuse, so it is all stripped and replaced with the
 * credential in the jev-opus config (~/.config/jev-opus/.env), or else the `claude` login.
 * `config.claudeCredentials` keeps provenance, so an inherited parent key is
 * never reintroduced unless JEV_OPUS_INHERIT_CREDENTIALS=1 — and the
 * `credential` label says which source won.
 *
 * `passthrough` (the wrapped `jev-opus claude` session) is the user's own Claude Code: it keeps the parent
 * environment and drops only PASSTHROUGH_BLOCKED, so CLAUDE_CODE_*, OTEL_* and MCP_* settings still apply.
 */
const INHERITED = /^(ANTHROPIC_|CLAUDE|MCP_|OTEL_)/;
const KEEP = new Set(['CLAUDE_CONFIG_DIR']);
// These belong to the parent router, never to Claude Code or its tool subprocesses.
const ROUTER_SECRETS = new Set([
  'JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY',
  'JEV_OPUS_ANTHROPIC_API_KEY', 'JEV_OPUS_CLAUDE_OAUTH_TOKEN', 'JEV_OPUS_ANTHROPIC_AUTH_TOKEN',
]);

/**
 * Variables that would route the child around the gateway, hand it a credential jev-opus did not choose, or
 * override the effort Jev sets. Everything else (CLAUDE_CODE_*, OTEL_*, MCP_*, ANTHROPIC_MODEL, …) is the user's
 * own configuration and reaches the child in `passthrough` mode.
 */
const PASSTHROUGH_BLOCKED = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', // credential provenance, see config.ts
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', // a parent's base URL would bypass the gateway; both are re-set by the launch
  'CLAUDE_CODE_EFFORT_LEVEL', // outranks every effort statement the gateway inserts
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', // other providers never reach ANTHROPIC_BASE_URL
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', // markers of a parent Claude Code session
]);

export interface ChildEnv {
  env: Record<string, string>;
  credential: string;
}

export function childEnv(
  base: NodeJS.ProcessEnv = process.env,
  opts: { connectors?: boolean; credentials?: ClaudeCredentials; passthrough?: boolean } = {},
): ChildEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (ROUTER_SECRETS.has(k)) continue;
    if (opts.passthrough ? PASSTHROUGH_BLOCKED.has(k) : INHERITED.test(k) && !KEEP.has(k)) continue;
    env[k] = v;
  }

  const c = opts.credentials ?? config.claudeCredentials;
  let credential = 'claude login (run `claude auth login` once)';
  if (c.apiKey.value) {
    env.ANTHROPIC_API_KEY = c.apiKey.value;
    credential = `ANTHROPIC_API_KEY from ${c.apiKey.source}`;
  } else if (c.oauthToken.value) {
    env.CLAUDE_CODE_OAUTH_TOKEN = c.oauthToken.value;
    credential = `CLAUDE_CODE_OAUTH_TOKEN from ${c.oauthToken.source}`;
  } else if (c.authToken.value) {
    env.ANTHROPIC_AUTH_TOKEN = c.authToken.value;
    credential = `ANTHROPIC_AUTH_TOKEN from ${c.authToken.source}`;
  }
  if (c.baseUrl.value) env.ANTHROPIC_BASE_URL = c.baseUrl.value;
  // claude.ai connectors (Gmail, Drive, …) are noise for a delegated coding task; opt back in with JEV_OPUS_CLAUDEAI_CONNECTORS=1.
  if (!opts.connectors && base.JEV_OPUS_CLAUDEAI_CONNECTORS !== '1') env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return { env, credential };
}
