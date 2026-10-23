// QYZY·translator · 后台服务：服务商配置、提示词、限速队列、流式请求与缓存。

const DEFAULT_PROVIDERS = [
  {
    id: 'intern',
    name: 'Intern TokenPlan',
    baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    apiKey: '',
    models: [
      'deepseek-v4-flash-0731',
      'deepseek-v4-pro-0813',
      'deepseek-v4-flash-vision',
      'intern-s2',
      'glm-5.3',
      'kimi-k2.6',
      'minimax-m3',
      'qwen3.8-27b',
    ],
    defaultModel: 'deepseek-v4-flash-0731',
  },
  {
    id: 'ofox',
    name: 'OfoxAI',
    baseUrl: 'https://api.ofox.ai/v1',
    apiKey: '',
    models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'openai/gpt-5-nano'],
    defaultModel: 'deepseek/deepseek-v4-pro',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    models: ['deepseek/deepseek-chat-v3.1', 'google/gemini-2.5-flash'],
    defaultModel: 'deepseek/deepseek-chat-v3.1',
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    models: ['qwen2.5:7b', 'qwen2.5-coder:7b'],
    defaultModel: 'qwen2.5:7b',
  },
];

const DEFAULT_GLOSSARY = `segment tree=线段树
Fenwick tree=树状数组
binary indexed tree=树状数组
disjoint set union=并查集
union-find=并查集
dynamic programming=动态规划
greedy=贪心
binary search=二分
two pointers=双指针
sliding window=滑动窗口
prefix sum=前缀和
suffix sum=后缀和
adjacency list=邻接表
adjacency matrix=邻接矩阵
shortest path=最短路
minimum spanning tree=最小生成树
topological sort=拓扑排序
strongly connected component=强连通分量
lowest common ancestor=最近公共祖先
heavy-light decomposition=树链剖分
centroid decomposition=点分治
persistent segment tree=可持久化线段树
trie=字典树
suffix array=后缀数组
hash=哈希
permutation=排列
subsequence=子序列
subarray=子数组
subset=子集
bitmask=状压
modulo=取模
overflow=溢出
constraint=约束
test case=测试用例
time limit per test=单测试点时限
memory limit per test=单测试点内存限制
input=输入
output=输出
sample input=样例输入
sample output=样例输出
note=提示
interactive=交互
`;

const DEFAULT_SETTINGS = {
  engine: 'api',
  activeProviderId: 'intern',
  activeModel: 'deepseek-v4-flash-0731',
  qualityMode: false,
  showFloatButton: true,
  shortTextMinWords: 4,
  glossaryEnabled: true,
  cacheEnabled: false,
  webMaxTurns: 8,
  hoverPrefetch: true,
  hoverPrefetchDelayMs: 350,
  glossary: DEFAULT_GLOSSARY,
  providers: DEFAULT_PROVIDERS,
};

const SYSTEM_PROMPT = [
  '你是一名竞赛编程与计算机科学领域的专业译者。把用户给出的文本翻译成简体中文。',
  '规则：',
  '1. 只输出译文，不要解释、不要加引号、不要复述原文。',
  '2. 文本中的 [[C1]]、[[C2]] 这类占位符代表代码、公式或必须保持原样的内容：必须原样保留，不能翻译、改写、增删或调换顺序。',
  '3. 专业术语按术语表翻译；术语首次出现时可写成「中文（English）」，之后只写中文。',
  '4. 保留原文的换行、列表与段落结构。',
  '5. 已经是中文的部分保持原样，不要重译。',
  '6. 数学符号、变量名、时间复杂度写法（如 O(n log n)）保持原样。',
  '7. LaTeX 公式（$...$、$$...$$、\\(...\\)、\\[...\\]）原样保留，不要改写或翻译。',
].join('\n');

const BATCH_PROMPT = [
  '本次输入包含多个片段，每个片段以 [[SEG0]]、[[SEG1]] 这样的标记开头。',
  '请逐段翻译，并在输出中用同样的标记分隔各段译文。',
  '标记必须原样保留、顺序不变，不得合并、拆分或遗漏片段。',
].join('\n');

const state = {
  settings: null,
  controllers: new Map(),
  cache: new Map(),
  prefetch: new Map(),
  prefetchCount: 0,
  lastPrefetchAt: 0,
  web: new Map(),
  webTurns: 0,
  inflight: 0,
  slots: [],
  lastRequestAt: 0,
};

const MAX_CONCURRENCY = 3;
// TokenPlan 生成模型限额 50 RPM；留出余量，整页翻译不会被 429 打断。
const MIN_GAP_MS = 1300;
const MAX_CACHE = 400;
const CACHE_STORAGE_KEY = 'translationCache';
const CACHE_MAX_CHARS = 1_500_000;

function maxTokensFor(text) {
  const chars = String(text || '').length;
  // 英文原文约 1 字符 → 0.3 token，中文译文再占一部分；1.6 倍字符数留足余量。
  return Math.min(8192, Math.max(512, Math.ceil(chars * 1.6) + 256));
}

function withDefaults(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if (!Array.isArray(merged.providers) || merged.providers.length === 0) {
    merged.providers = DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  }
  merged.providers = merged.providers.map((p) => ({
    ...p,
    models: Array.isArray(p.models) ? p.models : [],
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    extraBody: typeof p.extraBody === 'string' ? p.extraBody : '',
  }));
  return merged;
}

async function getSettings() {
  if (state.settings) return state.settings;
  const stored = await chrome.storage.local.get('settings');
  state.settings = withDefaults(stored.settings);
  return state.settings;
}

async function saveSettings(next) {
  state.settings = withDefaults(next);
  await chrome.storage.local.set({ settings: state.settings });
  return state.settings;
}

function activeProvider(settings) {
  return (
    settings.providers.find((p) => p.id === settings.activeProviderId) ||
    settings.providers[0]
  );
}

function parseGlossary(settings) {
  if (!settings.glossaryEnabled) return [];
  return String(settings.glossary || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
    .filter(([term, translation]) => term && translation);
}

function glossaryFor(settings, text) {
  const entries = parseGlossary(settings);
  if (entries.length === 0) return '';
  const haystack = String(text).toLowerCase();
  const hits = entries.filter(([term]) => haystack.includes(term.toLowerCase()));
  const chosen = hits.length > 0 ? hits.slice(0, 40) : [];
  if (chosen.length === 0) return '';
  return '术语表（英文=中文）：\n' + chosen.map(([term, translation]) => `${term}=${translation}`).join('\n');
}

function buildMessages(settings, text, batch) {
  const glossary = glossaryFor(settings, text);
  const system = [SYSTEM_PROMPT, batch ? BATCH_PROMPT : '', glossary].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
}

function cacheKey(provider, model, text) {
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${provider}:${model}:${text.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

let cacheLoaded = false;
let cacheSaveTimer = 0;

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const entries = stored[CACHE_STORAGE_KEY];
    if (entries && typeof entries === 'object') {
      for (const [key, value] of Object.entries(entries)) {
        if (value && typeof value.text === 'string') state.cache.set(key, value.text);
      }
    }
  } catch {
    // 缓存读取失败不影响翻译。
  }
}

function persistCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(async () => {
    const output = {};
    let total = 0;
    const entries = Array.from(state.cache.entries()).reverse();
    for (const [key, text] of entries) {
      if (total + text.length > CACHE_MAX_CHARS) break;
      output[key] = { text, at: Date.now() };
      total += text.length;
    }
    try {
      await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: output });
    } catch {
      // 超出配额时保留内存缓存即可。
    }
  }, 1200);
}

async function cacheGet(key) {
  await ensureCacheLoaded();
  const hit = state.cache.get(key);
  if (!hit) return null;
  state.cache.delete(key);
  state.cache.set(key, hit);
  return hit;
}

async function cacheSet(key, value) {
  await ensureCacheLoaded();
  state.cache.set(key, value);
  while (state.cache.size > MAX_CACHE) {
    const oldest = state.cache.keys().next().value;
    state.cache.delete(oldest);
  }
  persistCacheSoon();
}

async function clearCache() {
  state.cache.clear();
  await chrome.storage.local.remove(CACHE_STORAGE_KEY);
}

async function acquireSlot() {
  while (state.inflight >= MAX_CONCURRENCY) {
    await new Promise((resolve) => state.slots.push(resolve));
  }
  state.inflight += 1;
  const wait = Math.max(0, state.lastRequestAt + MIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  state.lastRequestAt = Date.now();
}

function releaseSlot() {
  state.inflight = Math.max(0, state.inflight - 1);
  const next = state.slots.shift();
  if (next) next();
}

function providerExtra(provider) {
  if (!provider || !provider.extraBody) return {};
  try {
    const value = JSON.parse(provider.extraBody);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function extractContent(parsed) {
  const choice = parsed?.choices?.[0];
  if (!choice) return '';
  const candidates = [
    choice.delta?.content,
    choice.message?.content,
    choice.text,
    parsed?.content,
    parsed?.message?.content,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function stripReasoning(text) {
  return String(text || '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<\|\s*thinking\s*\|>[\s\S]*?<\|\s*\/\s*thinking\s*\|>/gi, '')
    .trim();
}

async function streamChat(provider, model, messages, { signal, onDelta, maxTokens }) {
  const endpoint = String(provider.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.2,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...providerExtra(provider),
    }),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`HTTP ${response.status} ${detail.slice(0, 300)}`.trim());
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawAll = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    rawAll += chunkText;
    buffer += chunkText;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return full;
      try {
        const parsed = JSON.parse(data);
        const content = extractContent(parsed);
        if (content) {
          full += content;
          onDelta(content);
        }
      } catch {
        // 忽略非 JSON 的心跳行。
      }
    }
  }
  // 有些网关忽略 stream 标志，直接返回一个 JSON；这里兜底解析。
  if (!full) {
    try {
      const parsed = JSON.parse(rawAll.trim());
      const content = extractContent(parsed);
      if (content) {
        full = content;
        onDelta(content);
      }
    } catch {
      // 不是 JSON，保持空结果。
    }
  }
  return full;
}

function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function prefetchText(text) {
  const settings = await getSettings();
  if (!settings.cacheEnabled) return;
  const provider = activeProvider(settings);
  if (!provider || !provider.baseUrl) return;
  const model = provider.models.includes(settings.activeModel)
    ? settings.activeModel
    : provider.defaultModel;
  if (!model) return;
  if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) return;
  const key = cacheKey(provider.id, model, text);
  if (state.prefetch.has(key)) return;
  if (await cacheGet(key)) return;
  // 用户正在等待的翻译优先；预取只在空闲时做，避免抢占队列。
  if (state.inflight > 0) return;
  if (Date.now() - state.lastPrefetchAt < MIN_GAP_MS) return;
  if (state.prefetchCount >= 60) return;
  state.prefetchCount += 1;
  state.lastPrefetchAt = Date.now();
  const task = (async () => {
    await acquireSlot();
    try {
      const full = await streamChat(provider, model, buildMessages(settings, text, false), {
        onDelta: () => {},
        maxTokens: maxTokensFor(text),
      });
      if (full) await cacheSet(key, full);
    } catch {
      // 预取失败保持静默，用户点击时再正常请求一次。
    } finally {
      releaseSlot();
    }
  })();
  state.prefetch.set(key, task);
  task.finally(() => state.prefetch.delete(key));
  return task;
}

async function handleTranslate(message, sender) {
  const settings = await getSettings();
  let provider = activeProvider(settings);
  let model = settings.activeModel;
  if (!provider) {
    sendToTab(sender?.tab?.id, {
      type: 'tr-error',
      requestId: String(message.requestId || ''),
      error: '尚未配置服务商',
    });
    return { ok: false };
  }
  if (!model || !provider.models.includes(model)) model = provider.defaultModel;
  // 当前服务商没填 Key 时，自动改用另一个已配置 Key 的服务商，避免“页面能开但永远报没 Key”。
  if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl || '')) {
    const fallback = settings.providers.find((item) => item.apiKey && item.baseUrl);
    if (fallback) {
      provider = fallback;
      model = fallback.defaultModel || fallback.models[0] || '';
    }
  }
  const text = String(message.text || '');
  const requestId = String(message.requestId || '');
  const tabId = sender?.tab?.id;
  if (!provider || !provider.baseUrl || !model) {
    sendToTab(tabId, { type: 'tr-error', requestId, error: '尚未配置服务商或模型' });
    return { ok: false };
  }
  if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) {
    sendToTab(tabId, {
      type: 'tr-error',
      requestId,
      error: `尚未填写 API Key（当前服务商：${provider.name}；引擎：API）`,
    });
    return { ok: false };
  }
  const key = cacheKey(provider.id, model, text);
  const pendingPrefetch = state.prefetch.get(key);
  if (pendingPrefetch) {
    // 悬停预取正在跑同一段：等它写缓存，不再发第二次请求。
    await pendingPrefetch.catch(() => {});
  }
  const cached = settings.cacheEnabled ? await cacheGet(key) : null;
  if (cached) {
    sendToTab(tabId, { type: 'tr-delta', requestId, text: cached });
    sendToTab(tabId, { type: 'tr-done', requestId, ms: 0, cached: true, model });
    return { ok: true, cached: true };
  }
  const startedAt = Date.now();
  let firstTokenAt = 0;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120000);
  state.controllers.set(requestId, controller);
  try {
    await acquireSlot();
    let streamed = '';
    let full = '';
    for (let attempt = 0; ; attempt += 1) {
      try {
        full = await streamChat(provider, model, buildMessages(settings, text, Boolean(message.batch)), {
          signal: controller.signal,
          maxTokens: maxTokensFor(text),
          onDelta: (delta) => {
            if (!firstTokenAt) firstTokenAt = Date.now();
            streamed += delta;
            sendToTab(tabId, { type: 'tr-delta', requestId, text: delta });
          },
        });
        break;
      } catch (error) {
        const status = error?.status;
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (!retryable || attempt >= 1 || streamed !== '' || controller.signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1600));
      }
    }
    const result = stripReasoning(full || streamed).trim();
    if (!result) {
      sendToTab(tabId, {
        type: 'tr-error',
        requestId,
        error: '模型没有返回正文（可能是关思考参数导致空响应，或网关返回格式不兼容）',
      });
      return { ok: false };
    }
    if (settings.cacheEnabled) await cacheSet(key, result);
    sendToTab(tabId, {
      type: 'tr-done',
      requestId,
      ms: Date.now() - startedAt,
      ttft: firstTokenAt ? firstTokenAt - startedAt : null,
      model,
    });
    return { ok: true };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      sendToTab(tabId, {
        type: 'tr-error',
        requestId,
        error: '请求超时（120 秒），请重试或换一个更快的模型',
      });
      return { ok: false };
    }
    if (controller.signal.aborted || error?.name === 'AbortError' || /aborted/i.test(messageText)) {
      sendToTab(tabId, { type: 'tr-cancelled', requestId });
      return { ok: false, cancelled: true };
    }
    sendToTab(tabId, {
      type: 'tr-error',
      requestId,
      error: messageText,
    });
    return { ok: false };
  } finally {
    clearTimeout(timeoutTimer);
    state.controllers.delete(requestId);
    releaseSlot();
  }
}

function buildWebPrompt(settings, text) {
  return `把下面文本翻译成简体中文；保留换行、[[C0]] 占位符与 LaTeX 公式（$...$、\\[...\\]）原样；只输出译文。\n\n${text}`;
}

async function ensureDeepSeekTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (tabs && tabs[0]?.id) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: true });
  return tab.id;
}

async function waitForWebReady(tabId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'web-ping' });
      if (response?.ok) return response;
    } catch {
      // 页面还没加载好，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function handleWebTranslate(message, sender) {
  const settings = await getSettings();
  const requestId = String(message.requestId || '');
  const originTab = sender?.tab?.id;
  const text = String(message.text || '');
  if (!originTab) return { ok: false, error: '没有来源标签页' };
  if (!text.trim()) return { ok: false, error: '空文本' };

  let tabId;
  try {
    tabId = await ensureDeepSeekTab();
  } catch (error) {
    sendToTab(originTab, {
      type: 'tr-error',
      requestId,
      error: `无法打开 DeepSeek 网页版：${String(error?.message || error)}`,
    });
    return { ok: false };
  }
  const ready = await waitForWebReady(tabId);
  if (!ready) {
    sendToTab(originTab, {
      type: 'tr-error',
      requestId,
      error: '无法连接 DeepSeek 网页版：请确认 chat.deepseek.com 已打开并登录',
    });
    return { ok: false };
  }

  const limit = Math.max(1, Number(settings.webMaxTurns) || 8);
  if (state.webTurns >= limit) {
    // 先清零再发命令：即使网页脚本的响应丢失，也不会导致之后每次翻译都重复删旧开新。
    state.webTurns = 0;
    try {
      await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'web-new-chat' }),
        new Promise((resolve) => setTimeout(resolve, 12000)),
      ]);
    } catch {
      // 新开失败时继续用当前对话，下一个周期再试。
    }
  }

  const webId = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    originTab,
    requestId,
    startedAt: Date.now(),
    firstAt: 0,
    timer: 0,
    expected: [...text.matchAll(/\[\[C\d+\]\]/g)].map((match) => match[0]),
  };
  record.timer = setTimeout(() => {
    if (!state.web.has(webId)) return;
    state.web.delete(webId);
    sendToTab(originTab, {
      type: 'tr-error',
      requestId,
      error: 'DeepSeek 网页版 300 秒未返回，请检查网页是否卡住或未登录',
    });
  }, 300000);
  state.web.set(webId, record);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'web-translate',
      webId,
      prompt: buildWebPrompt(settings, text),
      maxTurns: Math.max(1, Number(settings.webMaxTurns) || 8),
    });
  } catch (error) {
    clearTimeout(record.timer);
    state.web.delete(webId);
    sendToTab(originTab, {
      type: 'tr-error',
      requestId,
      error: `无法向 DeepSeek 网页版发送任务：${String(error?.message || error)}`,
    });
    return { ok: false };
  }
  return { ok: true, engine: 'web' };
}

async function testProvider(provider) {
  const base = String(provider.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'Base URL 为空' };
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${String(provider.apiKey).trim()}`;
  const started = Date.now();

  // 第一段：/models，用来区分「网络不可达 / Key 无效」与「聊天接口慢」。
  try {
    const probe = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (probe.status === 401 || probe.status === 403) {
      const detail = await probe.text().catch(() => '');
      return {
        ok: false,
        error: `鉴权失败（HTTP ${probe.status}）：${detail.slice(0, 160) || 'Key 无效或无权限'}`,
      };
    }
  } catch (error) {
    const name = error?.name || 'Error';
    return {
      ok: false,
      error: `网络阶段失败（${Date.now() - started}ms，${base}）：${name} ${error?.message || ''}`.trim(),
    };
  }

  // 第二段：流式 chat，只等第一个正文 token，用来测「点击到出字」的真实延迟。
  const model = provider.defaultModel || provider.models?.[0];
  if (!model) return { ok: false, error: '没有可用的模型 ID' };
  const chatStarted = Date.now();
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1024,
        stream: true,
        ...providerExtra(provider),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${response.status}（模型 ${model}）：${detail.slice(0, 200)}`.trim(),
      };
    }
    if (!response.body) return { ok: false, error: '响应没有可读流' };
    const contentType = response.headers.get('content-type') || '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let rawAll = '';
    let reasoningMs = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      rawAll += chunkText;
      buffer += chunkText;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if ((delta?.reasoning_content || delta?.reasoning) && !reasoningMs) {
            reasoningMs = Date.now() - chatStarted;
          }
          const content = extractContent(parsed);
          if (content) {
            const ttft = Date.now() - chatStarted;
            reader.cancel().catch(() => {});
            return {
              ok: true,
              ms: Date.now() - started,
              ttft,
              reasoningMs,
            };
          }
        } catch {
          // 忽略非 JSON 心跳。
        }
      }
    }
    // 网关忽略 stream、直接返回 JSON 时，从完整响应里再取一次。
    try {
      const parsed = JSON.parse(rawAll.trim());
      const content = extractContent(parsed);
      if (content) {
        return {
          ok: true,
          ms: Date.now() - started,
          ttft: Date.now() - chatStarted,
          reasoningMs,
        };
      }
    } catch {
      // 保持下面的错误。
    }
    return {
      ok: false,
      error: `流已结束但没有正文（模型 ${model}；content-type: ${contentType || '未知'}；片段：${rawAll
        .replace(/\s+/g, ' ')
        .slice(0, 180) || '空'}）`,
    };
  } catch (error) {
    const name = error?.name || 'Error';
    const hint =
      name === 'TimeoutError' || name === 'AbortError'
        ? '60 秒内没有等到第一个正文 token，模型可能在长时间思考或排队'
        : `${name} ${error?.message || ''}`;
    return {
      ok: false,
      error: `聊天阶段失败（${Date.now() - chatStarted}ms，模型 ${model}）：${hint}`,
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (type === 'translate') {
    (async () => {
      const settings = await getSettings();
      if (settings.engine === 'web') return handleWebTranslate(message, sender);
      return handleTranslate(message, sender);
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (type === 'web-snapshot') {
    const record = state.web.get(message.webId);
    if (record) {
      if (!record.firstAt) record.firstAt = Date.now();
      sendToTab(record.originTab, {
        type: 'tr-snapshot',
        requestId: record.requestId,
        text: String(message.text || ''),
      });
    }
    return false;
  }
  if (type === 'web-done') {
    const record = state.web.get(message.webId);
    if (record) {
      clearTimeout(record.timer);
      state.web.delete(message.webId);
      const text = stripReasoning(String(message.text || ''));
      const missing = (record.expected || []).filter((token) => !text.includes(token));
      const warning = missing.length
        ? `代码占位符缺失：${missing.slice(0, 4).join(', ')}，相关代码可能没有回填，建议重试`
        : '';
      sendToTab(record.originTab, {
        type: 'tr-done',
        requestId: record.requestId,
        ms: Date.now() - record.startedAt,
        ttft: record.firstAt ? record.firstAt - record.startedAt : null,
        model: 'DeepSeek 网页版',
        warning,
      });
      state.webTurns += 1;
    }
    return false;
  }
  if (type === 'web-error') {
    const record = state.web.get(message.webId);
    if (record) {
      clearTimeout(record.timer);
      state.web.delete(message.webId);
      sendToTab(record.originTab, {
        type: 'tr-error',
        requestId: record.requestId,
        error: String(message.error || 'DeepSeek 网页版执行失败'),
      });
    }
    return false;
  }
  if (type === 'prefetch') {
    prefetchText(String(message.text || '')).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (type === 'cancel') {
    const controller = state.controllers.get(String(message.requestId));
    if (controller) controller.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (type === 'get-settings') {
    getSettings().then((settings) => sendResponse({ settings }), () => sendResponse({ settings: null }));
    return true;
  }
  if (type === 'save-settings') {
    saveSettings(message.settings)
      .then((settings) => {
        chrome.tabs.query({}).then((tabs) => {
          for (const tab of tabs) {
            if (tab.id) sendToTab(tab.id, { type: 'tr-settings-changed' });
          }
        });
        sendResponse({ ok: true, settings });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (type === 'test-provider') {
    testProvider(message.provider).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (type === 'clear-cache') {
    clearCache().then(
      () => sendResponse({ ok: true, size: 0 }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (type === 'cache-store') {
    (async () => {
      const settings = await getSettings();
      if (!settings.cacheEnabled) return { ok: true, skipped: true };
      const provider = activeProvider(settings);
      if (!provider) return { ok: false };
      const model = provider.models.includes(settings.activeModel)
        ? settings.activeModel
        : provider.defaultModel;
      const key = cacheKey(provider.id, model, String(message.text || ''));
      await cacheSet(key, String(message.translation || ''));
      return { ok: true };
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (type === 'cache-stats') {
    ensureCacheLoaded().then(
      () => sendResponse({ ok: true, size: state.cache.size }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'translate-page') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs[0];
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'translate-page' }).catch(() => {});
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await getSettings();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '翻译选中内容',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'translate-selection' || !tab?.id) return;
  chrome.tabs
    .sendMessage(tab.id, { type: 'translate-selection', text: info.selectionText || '' })
    .catch(() => {});
});
