const $ = (selector) => document.querySelector(selector);

let settings = null;

function currentProvider() {
  if (!settings) return null;
  return (
    settings.providers.find((provider) => provider.id === settings.activeProviderId) ||
    settings.providers[0] ||
    null
  );
}

function qualityCandidate(provider) {
  if (!provider) return null;
  return (
    provider.models.find((model) => /pro|max|opus|sonnet|gpt-5\.5|gpt-5\.4/i.test(model)) ||
    provider.defaultModel ||
    provider.models[0] ||
    null
  );
}

function fillSelect(select, values, selected) {
  select.textContent = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    if (value === selected) option.selected = true;
    select.appendChild(option);
  }
}

function render() {
  const provider = currentProvider();
  const webEngine = settings.engine === 'web';
  for (const id of ['#providerField', '#modelField', '#qualityRow']) {
    const node = $(id);
    if (node) node.style.display = webEngine ? 'none' : '';
  }
  if (!provider) {
    $('#status').textContent = '没有可用的服务商，请打开设置添加';
    return;
  }
  fillSelect(
    $('#provider'),
    settings.providers.map((item) => item.id),
    provider.id,
  );
  $('#provider').selectedOptions[0].textContent = provider.name;

  fillSelect($('#model'), provider.models, settings.activeModel);
  if (provider.models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（请在设置里填写模型）';
    $('#model').appendChild(option);
  }

  const status = $('#status');
  status.classList.remove('ok', 'warn');
  if (settings.engine === 'web') {
    status.textContent = 'DeepSeek 网页版（自动填入并发送）';
    status.classList.add('ok');
  } else if (provider.apiKey || /localhost|127\.0\.0\.1/.test(provider.baseUrl || '')) {
    status.textContent = `Key 已保存 · ${provider.name}`;
    status.classList.add('ok');
  } else {
    status.textContent = '尚未填写 API Key，请到设置里添加';
    status.classList.add('warn');
  }

  $('#qualityMode').checked = Boolean(settings.qualityMode);
  $('#showFloat').checked = settings.showFloatButton !== false;
}

async function save(patch) {
  settings = { ...settings, ...patch };
  const response = await chrome.runtime.sendMessage({ type: 'save-settings', settings });
  if (response?.settings) settings = response.settings;
  render();
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: 'get-settings' });
  settings = response?.settings;
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
  if (!settings) {
    $('#status').textContent = '读取配置失败';
    return;
  }
  render();
}

$('#provider').addEventListener('change', async (event) => {
  const provider = settings.providers.find((item) => item.id === event.target.value);
  if (!provider) return;
  await save({
    activeProviderId: provider.id,
    activeModel: provider.defaultModel || provider.models[0] || '',
  });
});

$('#model').addEventListener('change', async (event) => {
  await save({ activeModel: event.target.value });
});

$('#qualityMode').addEventListener('change', async (event) => {
  const provider = currentProvider();
  const checked = event.target.checked;
  const nextModel = checked
    ? qualityCandidate(provider)
    : provider?.defaultModel || provider?.models[0] || settings.activeModel;
  await save({ qualityMode: checked, activeModel: nextModel });
});

$('#showFloat').addEventListener('change', async (event) => {
  await save({ showFloatButton: event.target.checked });
});

$('#translatePage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'translate-page' }).catch(() => {});
  window.close();
});

$('#clearPage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'clear-page' }).catch(() => {});
  window.close();
});

$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#aboutLink').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html#about') });
});

load();
