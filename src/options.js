const $ = (selector) => document.querySelector(selector);

let settings = null;
let draft = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, kind) {
  const node = $('#saveStatus');
  node.textContent = message;
  node.classList.remove('ok', 'bad');
  if (kind) node.classList.add(kind);
}

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === `tab-${name}`);
  }
}

function bindField(input, provider, field) {
  input.value = Array.isArray(provider[field]) ? provider[field].join(', ') : provider[field] || '';
  input.addEventListener('input', () => {
    if (Array.isArray(provider[field])) {
      provider[field] = input.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      provider[field] = input.value;
    }
  });
}

function buildCard(provider) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = provider.id;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('strong');
  title.textContent = provider.name || provider.id;
  head.appendChild(title);
  if (draft.activeProviderId === provider.id) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '当前';
    head.appendChild(tag);
  }
  card.appendChild(head);

  for (const [field, label] of [
    ['name', '名称'],
    ['baseUrl', 'Base URL'],
    ['models', '模型（逗号分隔）'],
    ['defaultModel', '默认模型'],
  ]) {
    const wrapper = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    bindField(input, provider, field);
    if (field === 'name') {
      input.addEventListener('input', () => {
        title.textContent = input.value || provider.id;
      });
    }
    wrapper.append(text, input);
    card.appendChild(wrapper);
  }

  const extraLabel = document.createElement('label');
  const extraText = document.createElement('span');
  extraText.textContent = '额外请求参数（JSON，可空）';
  const extraInput = document.createElement('textarea');
  extraInput.rows = 2;
  extraInput.spellcheck = false;
  extraInput.placeholder = '{"thinking":{"type":"disabled"}}';
  bindField(extraInput, provider, 'extraBody');
  extraLabel.append(extraText, extraInput);
  card.appendChild(extraLabel);

  const keyLabel = document.createElement('label');
  const keyText = document.createElement('span');
  keyText.textContent = 'API Key';
  const keyRow = document.createElement('div');
  keyRow.className = 'key-row';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = '粘贴你的 API Key';
  bindField(keyInput, provider, 'apiKey');
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.textContent = '显示';
  reveal.addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    reveal.textContent = keyInput.type === 'password' ? '显示' : '隐藏';
  });
  keyRow.append(keyInput, reveal);
  keyLabel.append(keyText, keyRow);
  card.appendChild(keyLabel);

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const test = document.createElement('button');
  test.type = 'button';
  test.textContent = '测试连接';
  const result = document.createElement('div');
  result.className = 'test-result';
  test.addEventListener('click', async () => {
    test.disabled = true;
    result.className = 'test-result';
    result.textContent = '测试中…';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'test-provider', provider });
      if (response?.ok) {
        result.classList.add('ok');
        const parts = [];
        if (response.ttft) parts.push(`首字 ${(response.ttft / 1000).toFixed(1)}s`);
        if (response.reasoningMs) parts.push(`思考 ${(response.reasoningMs / 1000).toFixed(1)}s`);
        result.textContent = `连接成功${parts.length ? `（${parts.join(' · ')}）` : ''}`;
      } else {
        result.classList.add('bad');
        result.textContent = `失败：${response?.error || '未知错误'}`;
      }
    } catch (error) {
      result.classList.add('bad');
      result.textContent = `失败：${String(error)}`;
    } finally {
      test.disabled = false;
    }
  });

  const active = document.createElement('button');
  active.type = 'button';
  active.textContent = '设为当前';
  active.addEventListener('click', () => {
    draft.activeProviderId = provider.id;
    draft.activeModel = provider.defaultModel || provider.models[0] || '';
    renderProviders();
    setStatus('已切换当前服务商，记得保存', '');
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = '删除';
  remove.addEventListener('click', () => {
    if (!confirm(`删除服务商「${provider.name || provider.id}」？`)) return;
    draft.providers = draft.providers.filter((item) => item.id !== provider.id);
    if (draft.activeProviderId === provider.id) {
      const first = draft.providers[0];
      draft.activeProviderId = first?.id || '';
      draft.activeModel = first?.defaultModel || first?.models?.[0] || '';
    }
    renderProviders();
    setStatus('已删除，记得保存', '');
  });

  actions.append(test, active, remove);
  card.appendChild(actions);
  card.appendChild(result);
  return card;
}

function renderProviders() {
  const container = $('#providers');
  container.textContent = '';
  for (const provider of draft.providers) {
    container.appendChild(buildCard(provider));
  }
}

function renderTranslation() {
  $('#engine').value = draft.engine === 'web' ? 'web' : 'api';
  $('#webMaxTurns').value = draft.webMaxTurns || 8;
  $('#minWords').value = draft.shortTextMinWords || 4;
  $('#showFloat').checked = draft.showFloatButton !== false;
  $('#hoverPrefetch').checked = draft.hoverPrefetch !== false;
  $('#cacheEnabled').checked = draft.cacheEnabled === true;
  $('#prefetchDelay').value = draft.hoverPrefetchDelayMs || 350;
  $('#glossaryEnabled').checked = draft.glossaryEnabled !== false;
  $('#glossary').value = draft.glossary || '';
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: 'get-settings' });
  settings = response?.settings;
  if (!settings) {
    setStatus('读取配置失败', 'bad');
    return;
  }
  draft = clone(settings);
  renderProviders();
  renderTranslation();
  refreshCache();
  $('#aboutVersion').textContent = `v${chrome.runtime.getManifest().version}`;
  if (location.hash === '#about') switchTab('about');
  else switchTab('translation');
}

async function refreshCache() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'cache-stats' });
    $('#cacheSize').textContent = response?.ok ? `${response.size} 条` : '—';
  } catch {
    $('#cacheSize').textContent = '—';
  }
}

function collect() {
  draft.engine = $('#engine').value === 'web' ? 'web' : 'api';
  draft.webMaxTurns = Math.min(50, Math.max(1, Number($('#webMaxTurns').value) || 8));
  draft.shortTextMinWords = Math.max(1, Number($('#minWords').value) || 4);
  draft.showFloatButton = $('#showFloat').checked;
  draft.hoverPrefetch = $('#hoverPrefetch').checked;
  draft.cacheEnabled = $('#cacheEnabled').checked;
  draft.hoverPrefetchDelayMs = Math.min(
    1500,
    Math.max(150, Number($('#prefetchDelay').value) || 350),
  );
  draft.glossaryEnabled = $('#glossaryEnabled').checked;
  draft.glossary = $('#glossary').value;
  return draft;
}

$('#addProvider').addEventListener('click', () => {
  draft.providers.push({
    id: `custom-${Date.now().toString(36)}`,
    name: '自定义服务商',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
  });
  renderProviders();
  setStatus('已添加，填写后记得保存', '');
});

$('#clearCache').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'clear-cache' });
    await refreshCache();
    setStatus('缓存已清除', 'ok');
  } catch (error) {
    setStatus(`清除失败：${String(error)}`, 'bad');
  }
});

$('#save').addEventListener('click', async () => {
  setStatus('保存中…', '');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'save-settings',
      settings: collect(),
    });
    if (!response?.ok) throw new Error(response?.error || '保存失败');
    settings = response.settings;
    draft = clone(settings);
    renderProviders();
    renderTranslation();
    setStatus('已保存', 'ok');
  } catch (error) {
    setStatus(`保存失败：${String(error)}`, 'bad');
  }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#about') switchTab('about');
});

load();
