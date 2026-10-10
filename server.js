const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const SEARCH_TTL = 5 * 60 * 1000;
const README_TTL = 30 * 60 * 1000;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 30;
const cache = new Map();
const requestLog = new Map();
const AGENT_TTL = 15 * 60 * 1000;
const AGENT_RATE_LIMIT = 10;
const AI_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_BASE_URL = process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
const AI_MODEL = process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || 'deepseek-flash';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function clientAddress(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function isRateLimited(req) {
  const now = Date.now();
  const address = clientAddress(req);
  const recent = (requestLog.get(address) || []).filter((timestamp) => now - timestamp < RATE_WINDOW);
  recent.push(now);
  requestLog.set(address, recent);
  return recent.length > RATE_LIMIT;
}

function getCached(key) {
  const item = cache.get(key);
  if (!item || item.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value, ttl) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function agentConfigured() {
  return Boolean(AI_API_KEY);
}

function agentRateLimited(req) {
  const address = `agent:${clientAddress(req)}`;
  const now = Date.now();
  const recent = (requestLog.get(address) || []).filter((timestamp) => now - timestamp < RATE_WINDOW);
  recent.push(now);
  requestLog.set(address, recent);
  return recent.length > AGENT_RATE_LIMIT;
}

function agentPrompt(input) {
  const language = input.language === 'en' ? 'en' : 'zh';
  const languageRule = language === 'zh'
    ? 'Write summary, recommendation, evidence, risks, and next_steps in Simplified Chinese. Keep repository names, owners, URLs, languages, license identifiers, package names, framework names, and topic names unchanged.'
    : 'Write summary, recommendation, evidence, risks, and next_steps in English. Keep repository names, owners, URLs, languages, license identifiers, package names, framework names, and topic names unchanged.';
  return `You are the constrained analysis agent for Open Source Radar. You are not a general chatbot, code generator, marketer, or repository maintainer. Use only the supplied repository metadata and README excerpt. Never invent features, metrics, URLs, dates, licenses, framework support, security claims, or deployment steps. If evidence is missing, say "当前资料不足以确认" and add a verification step. ${languageRule}

Write for a beginner developer. Use plain, direct language. Explain technical terms the first time you use them. Replace abstract phrases such as "推进动作", "信号强", "构建潜力", and "生态成熟" with a concrete explanation of what the user should do and why. Do not praise a project only because it has many stars. Mention one practical limitation when the evidence supports it.

Choose exactly one decision: direct_use, extend, borrow_ui, or skip_for_now. Score activity, documentation, build_feasibility, utility, and portfolio as integers from 0 to 100 using the supplied evidence, not star count alone. Confidence must be an integer from 0 to 100 and must reflect confidence in the recommendation given the evidence.

Keep the output concise: summary <= 450 characters, recommendation <= 180 characters, each evidence/risk/next_step <= 160 characters. Return 2-4 evidence items, 0-4 risks, and 2-4 next_steps. Do not repeat the README or list every topic.

Return JSON only, with exactly this shape and no Markdown fences or commentary before/after it:
{"summary":"用普通人能看懂的短句说明项目是什么","fit_for":"说明什么样的人或项目适合使用它","pros":"用一句话说明最实用的优点","watch_out":"用一句话说明最需要注意的地方","recommendation":"明确说现在应该直接使用、二次改造、借鉴 UI 或暂不研究，并说明原因","decision":"direct_use | extend | borrow_ui | skip_for_now","confidence":0,"scores":{"activity":0,"documentation":0,"build_feasibility":0,"utility":0,"portfolio":0},"evidence":["2-4 简短依据"],"risks":["简短风险"],"next_steps":["2-4 个具体下一步"]}

Current interface language: ${language}
Repository facts and README excerpt:
${JSON.stringify(input)}`;
}

function extractJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('DeepSeek 返回了空内容。'), { code: 'EMPTY_PROVIDER_RESPONSE' });
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (nestedError) { /* fall through */ }
    }
    throw Object.assign(new Error('DeepSeek 返回的分析 JSON 无法解析。'), { code: 'INVALID_AGENT_JSON' });
  }
}

function normalizeAgentResult(value) {
  if (!value || typeof value !== 'object') throw new Error('Agent returned invalid JSON.');
  const scores = value.scores || {};
  const scoreKeys = ['activity', 'documentation', 'build_feasibility', 'utility', 'portfolio'];
  const decisions = ['direct_use', 'extend', 'borrow_ui', 'skip_for_now'];
  const normalizedScores = Object.fromEntries(scoreKeys.map((key) => [key, Math.min(100, Math.max(0, Math.round(Number(scores[key]) || 0)))]));
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item) => typeof item === 'string').slice(0, 5) : [];
  if (!evidence.length) throw Object.assign(new Error('Agent returned no evidence.'), { code: 'MISSING_EVIDENCE' });
  return {
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 700) : '',
    fit_for: typeof value.fit_for === 'string' ? value.fit_for.slice(0, 260) : '',
    pros: typeof value.pros === 'string' ? value.pros.slice(0, 260) : '',
    watch_out: typeof value.watch_out === 'string' ? value.watch_out.slice(0, 260) : '',
    recommendation: typeof value.recommendation === 'string' ? value.recommendation.slice(0, 500) : '',
    decision: decisions.includes(value.decision) ? value.decision : 'skip_for_now',
    confidence: Math.min(100, Math.max(0, Math.round(Number(value.confidence) || 0))),
    scores: normalizedScores,
    evidence,
    risks: Array.isArray(value.risks) ? value.risks.filter((item) => typeof item === 'string').slice(0, 6) : [],
    next_steps: Array.isArray(value.next_steps) ? value.next_steps.filter((item) => typeof item === 'string').slice(0, 6) : []
  };
}

function chatPrompt(input) {
  const language = input.language === 'en' ? 'en' : 'zh';
  const languageRule = language === 'zh' ? '用简体中文回答，技术名词保持原样。' : 'Answer in English; keep technical names unchanged.';
  return `You are the follow-up assistant inside Open Source Radar. ${languageRule} Use only the supplied repository facts, README excerpt, analysis result, and conversation history. Do not invent facts or claim that you ran commands, opened private data, installed software, or changed files. If the answer is not supported, say so clearly.

Keep the original technical wording when it is useful, but immediately add a plain-language explanation after it. Use this pattern when needed: "Technical term: ..." followed by "通俗地说：...". Explain terms such as framework, compiler, API, Docker, CI/CD, vulnerability, agent, and dependency in everyday language. Answer the user's exact question first. Use short paragraphs or bullets. Keep the answer under 500 Chinese characters or 700 English characters. Do not repeat the README.

Repository context:
${JSON.stringify(input.context)}

Conversation history:
${JSON.stringify(input.history)}`;
}

async function requestChatOnce(input, compact = false) {
  const requestInput = compact ? { ...input, context: { ...input.context, readme: input.context.readme.slice(0, 3500) }, history: input.history.slice(-4) } : input;
  const response = await fetch(`${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.15,
      max_tokens: compact ? 850 : 1100,
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      stream: false,
      messages: [
        { role: 'system', content: 'You are a bounded repository Q&A assistant. Answer the exact question clearly, preserve useful technical terms, add plain-language explanations, and do not fabricate.' },
        { role: 'user', content: chatPrompt(requestInput) }
      ]
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    let providerMessage = '';
    try { providerMessage = JSON.parse(raw).error?.message || ''; } catch (error) { providerMessage = ''; }
    const failure = classifyAgentFailure(response.status, providerMessage);
    const error = new Error(failure.message); error.code = failure.code; error.status = response.status; throw error;
  }
  let payload;
  try { payload = JSON.parse(raw); } catch (error) { throw Object.assign(new Error('DeepSeek 返回内容不是有效 JSON。'), { code: 'INVALID_PROVIDER_RESPONSE' }); }
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'length') throw Object.assign(new Error('DeepSeek 回答被截断，请重试。'), { code: 'TRUNCATED_CHAT_RESPONSE' });
  const content = choice?.message?.content;
  if (!content) throw Object.assign(new Error('DeepSeek 返回了空内容。'), { code: 'EMPTY_PROVIDER_RESPONSE' });
  return content.replace(/^\s*```(?:text)?\s*/i, '').replace(/\s*```\s*$/i, '').trim().slice(0, 1600);
}

async function requestChat(input) {
  try {
    return await requestChatOnce(input, false);
  } catch (error) {
    if (error.code !== 'TRUNCATED_CHAT_RESPONSE') throw error;
    return requestChatOnce(input, true);
  }
}

function classifyAgentFailure(status, providerMessage = '') {
  const message = providerMessage.toLowerCase();
  if (status === 401 || status === 403 || message.includes('api key') || message.includes('authentication')) return { code: 'AUTH_FAILED', message: 'DeepSeek API Key 无效或已失效，请重新生成密钥。' };
  if (status === 402 || status === 429 || message.includes('balance') || message.includes('quota') || message.includes('rate limit')) return { code: 'QUOTA_OR_LIMIT', message: 'DeepSeek 余额、额度或请求频率受限，请检查账户状态。' };
  if (status === 400 && (message.includes('model') || message.includes('parameter') || message.includes('response_format'))) return { code: 'REQUEST_INVALID', message: 'DeepSeek 模型或请求参数不兼容。' };
  if (status >= 500) return { code: 'PROVIDER_UNAVAILABLE', message: 'DeepSeek 服务暂时不可用，请稍后重试。' };
  return { code: 'AGENT_FAILED', message: 'Agent 请求失败，当前保留规则评分。' };
}

async function requestAgentOnce(input, compact = false) {
  const requestInput = compact ? { ...input, readme: input.readme.slice(0, 5000) } : input;
  const response = await fetch(`${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: compact ? 1200 : 1800,
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
      stream: false,
      messages: [
        { role: 'system', content: 'Return one compact JSON object only. Do not think aloud, repeat the README, or add Markdown. Facts first, no fabrication.' },
        { role: 'user', content: agentPrompt(requestInput) }
      ]
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    let providerMessage = '';
    try { providerMessage = JSON.parse(raw).error?.message || ''; } catch (error) { providerMessage = ''; }
    const failure = classifyAgentFailure(response.status, providerMessage);
    const error = new Error(failure.message); error.code = failure.code; error.status = response.status; throw error;
  }
  let payload;
  try { payload = JSON.parse(raw); } catch (error) { throw Object.assign(new Error('DeepSeek 返回内容不是有效 JSON。'), { code: 'INVALID_PROVIDER_RESPONSE' }); }
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'length') throw Object.assign(new Error('DeepSeek 输出被截断，请重试。'), { code: 'TRUNCATED_PROVIDER_RESPONSE' });
  const content = choice?.message?.content;
  if (!content) throw Object.assign(new Error('DeepSeek 返回了空内容。'), { code: 'EMPTY_PROVIDER_RESPONSE' });
  return normalizeAgentResult(extractJsonObject(content));
}

async function requestAgent(input) {
  try {
    return await requestAgentOnce(input, false);
  } catch (error) {
    if (error.code !== 'TRUNCATED_PROVIDER_RESPONSE') throw error;
    return requestAgentOnce({ ...input, readme: input.readme.slice(0, 3000) }, true);
  }
}

async function githubRequest(endpoint, accept) {
  const response = await fetch(endpoint, {
    headers: {
      Accept: accept,
      'User-Agent': 'open-source-radar-local-proxy'
    }
  });
  if (!response.ok) {
    const error = new Error(`GitHub request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function handleApi(req, res, url) {
  if (isRateLimited(req)) {
    return sendJson(res, 429, { error: 'Rate limit exceeded. Try again in a minute.' });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'open-source-radar-proxy', cacheEntries: cache.size, agentConfigured: agentConfigured() });
  }

  if (url.pathname === '/api/agent/analyze') {
    if (!agentConfigured()) return sendJson(res, 503, { error: 'Agent is not configured. Rule-based scoring remains active.' });
    if (agentRateLimited(req)) return sendJson(res, 429, { error: 'Agent rate limit exceeded. Try again later.' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        if (!input.repository || typeof input.repository !== 'object') return sendJson(res, 400, { error: 'Missing repository facts.' });
        const safeInput = { language: input.language === 'en' ? 'en' : 'zh', repository: input.repository, readme: typeof input.readme === 'string' ? input.readme.slice(0, 6000) : '' };
        const key = `agent:${JSON.stringify(safeInput)}`;
        const cached = getCached(key);
        if (cached) return sendJson(res, 200, { ...cached, cached: true });
        const result = await requestAgent(safeInput);
        setCached(key, result, AGENT_TTL);
        return sendJson(res, 200, { ...result, cached: false });
      } catch (error) {
        return sendJson(res, error.status === 401 || error.status === 403 ? 502 : (error.status === 429 ? 429 : 502), { error: error.message || 'Agent analysis failed.', code: error.code || 'AGENT_FAILED', fallback: 'rule_based' });
      }
    });
    return;
  }

  if (url.pathname === '/api/agent/chat') {
    if (!agentConfigured()) return sendJson(res, 503, { error: 'Agent is not configured.', code: 'AGENT_NOT_CONFIGURED' });
    if (agentRateLimited(req)) return sendJson(res, 429, { error: 'Agent rate limit exceeded. Try again later.', code: 'QUOTA_OR_LIMIT' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 60000) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        if (!input.context || typeof input.context !== 'object' || !Array.isArray(input.history)) return sendJson(res, 400, { error: 'Missing chat context.' });
        const safeInput = {
          language: input.language === 'en' ? 'en' : 'zh',
          context: { repository: input.context.repository || {}, readme: typeof input.context.readme === 'string' ? input.context.readme.slice(0, 10000) : '', analysis: input.context.analysis || {} },
          history: input.history.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-8).map((item) => ({ role: item.role, content: item.content.slice(0, 800) }))
        };
        const key = `chat:${JSON.stringify(safeInput)}`;
        const cached = getCached(key);
        if (cached) return sendJson(res, 200, { reply: cached, cached: true });
        const reply = await requestChat(safeInput);
        setCached(key, reply, 2 * 60 * 1000);
        return sendJson(res, 200, { reply, cached: false });
      } catch (error) {
        return sendJson(res, error.status === 429 ? 429 : 502, { error: error.message || 'Chat request failed.', code: error.code || 'CHAT_FAILED' });
      }
    });
    return;
  }

  if (url.pathname === '/api/github/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return sendJson(res, 400, { error: 'Missing q query parameter.' });
    const sort = ['stars', 'forks', 'updated'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'stars';
    const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
    const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') || 12), 1), 30);
    const page = Math.min(Math.max(Number(url.searchParams.get('page') || 1), 1), 10);
    const fresh = url.searchParams.get('fresh') === '1';
    const key = `search:${query}:${sort}:${order}:${perPage}:${page}`;
    const cached = fresh ? null : getCached(key);
    if (cached) return sendJson(res, 200, { ...cached, cached: true, page });

    try {
      const endpoint = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=${order}&per_page=${perPage}&page=${page}`;
      const response = await githubRequest(endpoint, 'application/vnd.github+json');
      const payload = await response.json();
      const result = { total_count: payload.total_count || 0, items: Array.isArray(payload.items) ? payload.items : [] };
      setCached(key, result, SEARCH_TTL);
      return sendJson(res, 200, { ...result, cached: false, page });
    } catch (error) {
      return sendJson(res, error.status === 403 ? 429 : 502, { error: 'GitHub search is temporarily unavailable.' });
    }
  }

  if (url.pathname === '/api/github/readme') {
    const owner = (url.searchParams.get('owner') || '').trim();
    const repo = (url.searchParams.get('repo') || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return sendJson(res, 400, { error: 'Invalid owner or repo.' });
    }
    const key = `readme:${owner}:${repo}`;
    const cached = getCached(key);
    if (cached) return sendText(res, 200, cached, 'text/plain; charset=utf-8');

    try {
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
      const response = await githubRequest(endpoint, 'application/vnd.github.raw+json');
      const text = await response.text();
      setCached(key, text, README_TTL);
      return sendText(res, 200, text, 'text/plain; charset=utf-8');
    } catch (error) {
      return sendJson(res, error.status === 403 ? 429 : 502, { error: 'README is temporarily unavailable.' });
    }
  }

  return sendJson(res, 404, { error: 'API route not found.' });
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendText(res, 404, 'Not found.');
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if ((url.pathname === '/api/agent/analyze' || url.pathname === '/api/agent/chat') && req.method === 'POST') return handleApi(req, res, url);
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Only GET requests and POST Agent requests are supported.' });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Open Source Radar running at http://${HOST}:${PORT}`);
});
