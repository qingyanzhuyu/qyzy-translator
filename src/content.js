// QYZY·translator · 内容脚本：段落按钮、划选翻译、整页翻译与内联译文块。
(() => {
  if (window.__qtLoaded) return;
  window.__qtLoaded = true;

  const BLOCK_SELECTOR = 'p,li,td,th,blockquote,dd,dt,h1,h2,h3,h4,h5,h6';
  const PROTECT_SELECTOR =
    'pre,code,kbd,samp,math,.katex,.katex-display,.MathJax,.MathJax_Display,.MathJax_Preview,.mjx-container,.tex-span,.tex-formula,[class*="katex"],[class*="MathJax"]';
  const OWN_UI = '.qt-panel,.qt-hover-btn,.qt-sel-btn,.qt-float,.qt-toast';

  const settings = {
    engine: 'api',
    shortTextMinWords: 4,
    showFloatButton: true,
    hoverPrefetch: true,
    hoverPrefetchDelayMs: 350,
    cacheEnabled: false,
  };
  const pending = new Map();
  const panelByBlock = new WeakMap();
  const prefetched = new Set();

  let hoverBlock = null;
  let hoverTimer = 0;
  let prefetchTimer = 0;
  let panelResizeTimer = 0;
  let prefetchCount = 0;
  let selectionInfo = null;
  let abortPage = false;

  function words(text) {
    return (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  }

  function mostlyChinese(text) {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return cjk > 0 && cjk >= latin;
  }

  function visible(element) {
    if (!element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function insideOwnUI(element) {
    return element instanceof Element && element.closest(OWN_UI) !== null;
  }

  function protect(root, tokens = []) {
    const nodes = Array.from(root.querySelectorAll(PROTECT_SELECTOR));
    for (const node of nodes) {
      if (!root.contains(node)) continue;
      if (node.parentElement && node.parentElement.closest(PROTECT_SELECTOR)) {
        continue;
      }
      const index = tokens.length;
      tokens.push(node.textContent || '');
      const placeholder = document.createTextNode(` [[C${index}]] `);
      node.replaceWith(placeholder);
    }
    return tokens;
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'TABLE', 'DD', 'DT', 'PRE', 'FIGURE', 'FIGCAPTION',
  ]);

  function textWithBreaks(root) {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push((node.nodeValue || '').replace(/\s+/g, ' '));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'BR') {
        parts.push('\n');
        return;
      }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) parts.push('\n');
      for (const child of node.childNodes) walk(child);
      if (isBlock) parts.push('\n');
    };
    walk(root);
    return parts
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function extractText(block, tokens) {
    const clone = block.cloneNode(true);
    for (const own of clone.querySelectorAll(OWN_UI)) own.remove();
    for (const junk of clone.querySelectorAll('script, style, noscript')) junk.remove();
    protect(clone, tokens);
    return textWithBreaks(clone);
  }

  function blockPayload(block) {
    const tokens = [];
    return { text: extractText(block, tokens), tokens };
  }

  function selectionPayload() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    for (const own of container.querySelectorAll(OWN_UI)) own.remove();
    const tokens = protect(container);
    const text = textWithBreaks(container);
    if (!text) return null;
    const rect = range.getBoundingClientRect();
    const rects = [...range.getClientRects()];
    const endRect = rects.length > 0 ? rects[rects.length - 1] : rect;
    const endNode = range.endContainer;
    const endElement = endNode.nodeType === Node.ELEMENT_NODE ? endNode : endNode.parentElement;
    let anchor = endElement ? endElement.closest(BLOCK_SELECTOR) : null;
    if (!anchor) {
      const endRange = range.cloneRange();
      endRange.collapse(false);
      anchor = nearestBlock(endRange.getBoundingClientRect());
    }
    return { text, tokens, rect, endRect, anchor };
  }

  function appendInline(container, text, tokens) {
    const parts = String(text).split(/(\[\[C\d+\]\])/g);
    for (const part of parts) {
      if (!part) continue;
      const match = part.match(/^\[\[C(\d+)\]\]$/);
      if (match) {
        const value = String(tokens[Number(match[1])] ?? part);
        if (value.includes('\n') || value.length > 80) {
          const pre = document.createElement('pre');
          pre.className = 'qt-pre';
          const code = document.createElement('code');
          code.textContent = value;
          pre.appendChild(code);
          container.appendChild(pre);
        } else {
          const code = document.createElement('code');
          code.className = 'qt-code';
          code.textContent = value;
          container.appendChild(code);
        }
        continue;
      }
      const inline = part.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
      for (const piece of inline) {
        if (!piece) continue;
        if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
          const code = document.createElement('code');
          code.className = 'qt-code';
          code.textContent = piece.slice(1, -1);
          container.appendChild(code);
        } else if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
          const strong = document.createElement('strong');
          strong.textContent = piece.slice(2, -2);
          container.appendChild(strong);
        } else {
          container.appendChild(document.createTextNode(piece));
        }
      }
    }
  }

  function resolveTokens(text, tokens) {
    return String(text).replace(/\[\[C(\d+)\]\]/g, (match, index) => tokens[Number(index)] ?? match);
  }

  function renderBody(body, text, tokens) {
    body.textContent = '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let fence = null;
    const flushFence = () => {
      if (fence === null) return;
      const pre = document.createElement('pre');
      pre.className = 'qt-pre';
      const code = document.createElement('code');
      code.textContent = resolveTokens(fence.join('\n'), tokens);
      pre.appendChild(code);
      body.appendChild(pre);
      fence = null;
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) {
        if (fence === null) fence = [];
        else flushFence();
        continue;
      }
      if (fence !== null) {
        fence.push(line);
        continue;
      }
      if (!trimmed) continue;
      const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
      if (heading) {
        const div = document.createElement('div');
        div.className = 'qt-h';
        appendInline(div, heading[1], tokens);
        body.appendChild(div);
      } else if (bullet || numbered) {
        const div = document.createElement('div');
        div.className = 'qt-li';
        appendInline(div, (bullet || numbered)[1], tokens);
        body.appendChild(div);
      } else {
        const div = document.createElement('div');
        div.className = 'qt-p';
        appendInline(div, trimmed, tokens);
        body.appendChild(div);
      }
    }
    flushFence();
  }

  function toast(message) {
    let node = document.querySelector('.qt-toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'qt-toast';
      document.documentElement.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('qt-show');
    clearTimeout(node.__timer);
    node.__timer = setTimeout(() => node.classList.remove('qt-show'), 2600);
  }

  function syncPanelWidth(panel) {
    if (panel.dataset.fixedWidth === '1') return;
    const anchor = panel.__block;
    if (!anchor || !anchor.isConnected || anchor === document.body) return;
    const parent = anchor.parentElement;
    if (!parent) return;
    const anchorRect = anchor.getBoundingClientRect();
    if (anchorRect.width <= 0) return;
    const parentRect = parent.getBoundingClientRect();
    const left = anchorRect.left - parentRect.left - parent.clientLeft;
    panel.style.width = `${Math.round(anchorRect.width)}px`;
    panel.style.maxWidth = '100%';
    panel.style.marginLeft = `${Math.max(0, Math.round(left))}px`;
  }

  function applySelectionLayout(panel, rect) {
    const parent = panel.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const width = Math.max(220, Math.min(rect.width, parent.clientWidth));
    const left = rect.left - parentRect.left - parent.clientLeft;
    panel.style.width = `${Math.round(width)}px`;
    panel.style.maxWidth = '100%';
    panel.style.marginLeft = `${Math.max(0, Math.round(left))}px`;
    panel.dataset.fixedWidth = '1';
  }

  function createPanel(anchor, model) {
    const panel = document.createElement('div');
    panel.className = 'qt-panel';
    panel.dataset.state = 'loading';
    const head = document.createElement('div');
    head.className = 'qt-head';
    const badge = document.createElement('span');
    badge.className = 'qt-badge';
    badge.textContent = '';
    try {
      badge.style.backgroundImage = `url("${chrome.runtime.getURL('icons/hat.png')}")`;
    } catch {
      // 旧版环境拿不到 getURL 时退回 CSS 里的相对路径。
    }
    const label = document.createElement('span');
    label.className = 'qt-model';
    label.textContent = model || '';
    const actions = document.createElement('span');
    actions.className = 'qt-actions';
    for (const [act, text] of [
      ['copy', '复制'],
      ['retry', '重试'],
      ['close', '✕'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.act = act;
      button.textContent = text;
      actions.appendChild(button);
    }
    head.append(badge, label, actions);
    const body = document.createElement('div');
    body.className = 'qt-body';
    body.textContent = '翻译中…';
    panel.append(head, body);
    if (anchor === document.body || !anchor.isConnected) {
      document.body.appendChild(panel);
    } else {
      anchor.insertAdjacentElement('afterend', panel);
    }
    panel.addEventListener('click', (event) => {
      const act = event.target instanceof Element ? event.target.closest('[data-act]')?.dataset.act : null;
      if (!act) return;
      event.preventDefault();
      event.stopPropagation();
      if (act === 'close') {
        const id = panel.dataset.requestId;
        if (id) chrome.runtime.sendMessage({ type: 'cancel', requestId: id }).catch(() => {});
        panel.remove();
        const block = panel.__block;
        if (block) panelByBlock.delete(block);
      } else if (act === 'copy') {
        navigator.clipboard.writeText(panel.__copyText || '').then(
          () => toast('已复制译文'),
          () => toast('复制失败'),
        );
      } else if (act === 'retry') {
        const previous = panel.dataset.requestId;
        if (previous) chrome.runtime.sendMessage({ type: 'cancel', requestId: previous }).catch(() => {});
        if (panel.__payload) translatePayload(panel.__payload, panel.__anchor, panel);
      }
    });
    return panel;
  }

  function ensurePanel(anchor, model, payload) {
    const existing = panelByBlock.get(anchor);
    if (existing && existing.isConnected) {
      existing.remove();
      panelByBlock.delete(anchor);
    }
    const panel = createPanel(anchor, model);
    panelByBlock.set(anchor, panel);
    panel.__block = anchor;
    panel.__anchor = anchor;
    panel.__payload = payload;
    syncPanelWidth(panel);
    return panel;
  }

  function translatePayload(payload, anchor, panel) {
    if (!payload || !payload.text.trim()) return Promise.resolve();
    clearTimeout(prefetchTimer);
    const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const target = panel || ensurePanel(anchor, '', payload);
    target.dataset.state = 'loading';
    target.dataset.requestId = requestId;
    target.__payload = payload;
    target.__anchor = anchor;
    const body = target.querySelector('.qt-body');
    body.textContent = '翻译中…';
    const record = { panel: target, payload, raw: '', rendered: 0 };
    pending.set(requestId, record);
    return new Promise((resolve) => {
      record.resolve = resolve;
      chrome.runtime
        .sendMessage({ type: 'translate', requestId, text: payload.text })
        .catch((error) => {
          if (isAbortLike(error)) {
            finishPanel(requestId, 'cancelled');
            toast('扩展已重新加载，请刷新页面后重试');
          } else {
            finishPanel(requestId, 'error', String(error));
          }
        });
    });
  }

  function isAbortLike(error) {
    const text = String(error?.message || error || '');
    return /aborted|context invalidated|message port closed|receiving end does not exist/i.test(text);
  }

  function applyMeta(panel, meta) {
    if (!meta || !panel) return;
    const label = panel.querySelector('.qt-model');
    if (!label) return;
    const model = meta.model || '';
    if (meta.cached) {
      label.textContent = `${model} · 缓存`;
    } else if (typeof meta.ms === 'number') {
      const first =
        typeof meta.ttft === 'number' ? `（首字 ${(meta.ttft / 1000).toFixed(1)}s）` : '';
      label.textContent = `${model} · ${(meta.ms / 1000).toFixed(1)}s${first}`;
    }
    if (typeof meta.ttft === 'number') {
      label.title = `首 token ${(meta.ttft / 1000).toFixed(1)}s`;
    }
  }

  function stripReasoningText(text) {
    return String(text || '')
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .trim();
  }

  function finishPanel(requestId, state, error, meta) {
    const record = pending.get(requestId);
    if (!record) return;
    if (record.frame) {
      cancelAnimationFrame(record.frame);
      record.frame = 0;
    }
    record.done = true;
    const { panel, payload } = record;
    panel.dataset.state = state;
    const body = panel.querySelector('.qt-body');
    if (state === 'done') {
      const finalText = stripReasoningText(record.raw).trim();
      renderBody(body, finalText, payload.tokens);
      panel.__copyText = finalText;
      applyMeta(panel, meta);
      if (meta?.warning) {
        const warn = document.createElement('div');
        warn.className = 'qt-warn';
        warn.textContent = `⚠ ${meta.warning}`;
        body.appendChild(warn);
        panel.dataset.warning = '1';
      }
    } else if (state === 'error') {
      body.textContent = `翻译失败：${error || '未知错误'}`;
    } else if (state === 'cancelled') {
      body.textContent = '已取消';
    }
    if (record.resolve) record.resolve();
    pending.delete(requestId);
  }

  function scheduleRender(record) {
    if (record.frame || record.done) return;
    record.frame = requestAnimationFrame(() => {
      record.frame = 0;
      if (record.done || !record.panel.isConnected) return;
      if (record.panel.dataset.state !== 'loading') return;
      const body = record.panel.querySelector('.qt-body');
      renderBody(body, record.raw, record.payload.tokens);
    });
  }

  function splitBatch(raw) {
    const segments = [];
    const chunks = String(raw).split(/\[\[SEG(\d+)\]\]/g);
    for (let i = 1; i < chunks.length; i += 2) {
      segments[Number(chunks[i])] = (chunks[i + 1] || '').trim();
    }
    return segments;
  }

  function renderBatch(record) {
    const segments = splitBatch(record.raw);
    record.panels.forEach((panel, index) => {
      if (!panel.isConnected) return;
      if (panel.dataset.state !== 'loading') return;
      const text = segments[index];
      if (!text) return;
      renderBody(panel.querySelector('.qt-body'), text, record.tokens[index]);
      panel.__copyText = text;
    });
  }

  function scheduleBatchRender(record) {
    if (record.frame || record.done) return;
    record.frame = requestAnimationFrame(() => {
      record.frame = 0;
      if (record.done) return;
      renderBatch(record);
    });
  }

  function finishBatch(requestId, state, error, meta) {
    const record = pending.get(requestId);
    if (!record) return;
    if (record.frame) {
      cancelAnimationFrame(record.frame);
      record.frame = 0;
    }
    record.done = true;
    if (state === 'done') {
      const segments = splitBatch(record.raw);
      const missing = [];
      record.panels.forEach((panel, index) => {
        if (!panel.isConnected) return;
        const text = segments[index] || '';
        const body = panel.querySelector('.qt-body');
        if (text) {
          panel.dataset.state = 'done';
          renderBody(body, text, record.tokens[index]);
          panel.__copyText = text;
          applyMeta(panel, meta);
          // 把批量子结果也写入单段缓存，之后单独点这段可以直接命中。
          chrome.runtime
            .sendMessage({
              type: 'cache-store',
              text: record.parts[index].text,
              translation: text,
            })
            .catch(() => {});
        } else {
          panel.dataset.state = 'loading';
          body.textContent = '翻译中…';
          missing.push(index);
        }
      });
      // 批量响应缺段（模型吃掉分隔符）时，自动退回单段请求。
      for (const index of missing) {
        translatePayload(
          { text: record.parts[index].text, tokens: record.tokens[index] },
          record.blocks[index],
          record.panels[index],
        );
      }
    } else {
      for (const panel of record.panels) {
        if (!panel.isConnected) continue;
        panel.dataset.state = state;
        panel.querySelector('.qt-body').textContent =
          state === 'error' ? `翻译失败：${error || '未知错误'}` : '已取消';
      }
    }
    if (record.resolve) record.resolve();
    pending.delete(requestId);
  }

  function translateBatch(blocks) {
    const parts = blocks.map((block) => {
      const tokens = [];
      return { text: extractText(block, tokens), tokens };
    });
    const combined = parts
      .map((part, index) => `[[SEG${index}]]\n${part.text}`)
      .join('\n\n');
    const panels = blocks.map((block, index) => {
      const panel = ensurePanel(block, '', {
        text: parts[index].text,
        tokens: parts[index].tokens,
      });
      panel.dataset.state = 'loading';
      panel.querySelector('.qt-body').textContent = '翻译中…';
      return panel;
    });
    const requestId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    for (const panel of panels) panel.dataset.requestId = requestId;
    const record = {
      kind: 'batch',
      panels,
      parts,
      tokens: parts.map((part) => part.tokens),
      blocks,
      raw: '',
      frame: 0,
    };
    pending.set(requestId, record);
    return new Promise((resolve) => {
      record.resolve = resolve;
      chrome.runtime
        .sendMessage({ type: 'translate', requestId, text: combined, batch: true })
        .catch((error) => {
          if (isAbortLike(error)) {
            finishBatch(requestId, 'cancelled');
            toast('扩展已重新加载，请刷新页面后重试');
          } else {
            finishBatch(requestId, 'error', String(error));
          }
        });
    });
  }

  function eligible(block, minWords) {
    if (!(block instanceof Element)) return false;
    if (block.closest(OWN_UI)) return false;
    if (!visible(block)) return false;
    const text = block.textContent || '';
    if (mostlyChinese(text)) return false;
    return words(text) >= minWords;
  }

  function hoverButton() {
    let button = document.querySelector('.qt-hover-btn');
    if (button) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'qt-hover-btn';
    button.textContent = '译';
    button.title = '翻译这一段';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const block = hoverBlock;
      hideHoverButton();
      clearTimeout(prefetchTimer);
      if (!block) return;
      if (panelByBlock.get(block)?.isConnected) return;
      translatePayload(blockPayload(block), block);
    });
    document.documentElement.appendChild(button);
    return button;
  }

  function showHoverButton(block) {
    const button = hoverButton();
    const rect = block.getBoundingClientRect();
    button.style.top = `${Math.max(4, rect.top + window.scrollY - 6)}px`;
    button.style.left = `${rect.right + window.scrollX - 30}px`;
    button.classList.add('qt-show');
  }

  function hideHoverButton() {
    clearTimeout(hoverTimer);
    document.querySelector('.qt-hover-btn')?.classList.remove('qt-show');
  }

  function schedulePrefetch(block) {
    clearTimeout(prefetchTimer);
    if (!settings.hoverPrefetch) return;
    if (!settings.cacheEnabled) return;
    if (settings.engine === 'web') return;
    if (prefetchCount >= 40) return;
    prefetchTimer = setTimeout(
      () => {
        if (!block.isConnected) return;
        if (panelByBlock.get(block)?.isConnected) return;
        const payload = blockPayload(block);
        if (!payload.text || prefetched.has(payload.text)) return;
        prefetched.add(payload.text);
        prefetchCount += 1;
        chrome.runtime.sendMessage({ type: 'prefetch', text: payload.text }).catch(() => {});
      },
      Math.max(150, Number(settings.hoverPrefetchDelayMs) || 350),
    );
  }

  function selectionButton() {
    let button = document.querySelector('.qt-sel-btn');
    if (button) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'qt-sel-btn';
    button.textContent = '译';
    button.title = '翻译选中内容';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const info = selectionInfo;
      hideSelectionButton();
      if (!info) return;
      const anchor = info.anchor || nearestBlock(info.rect) || document.body;
      translatePayload({ text: info.text, tokens: info.tokens }, anchor);
      const panel = panelByBlock.get(anchor);
      if (panel) {
        applySelectionLayout(panel, info.rect);
        setTimeout(() => panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
      }
    });
    document.documentElement.appendChild(button);
    return button;
  }

  function showSelectionButton(info) {
    const button = selectionButton();
    const base = info.endRect || info.rect;
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;
    const minTop = scrollY + 8;
    const maxTop = scrollY + window.innerHeight - 46;
    const top = Math.min(maxTop, Math.max(minTop, base.bottom + scrollY - 36));
    const maxLeft = scrollX + document.documentElement.clientWidth - 36;
    const left = Math.max(scrollX + 4, Math.min(maxLeft, base.right + scrollX + 4));
    button.style.top = `${top}px`;
    button.style.left = `${left}px`;
    button.classList.add('qt-show');
    selectionInfo = info;
  }

  function hideSelectionButton() {
    document.querySelector('.qt-sel-btn')?.classList.remove('qt-show');
    selectionInfo = null;
  }

  function nearestBlock(rect) {
    const x = Math.min(window.innerWidth - 1, Math.max(1, rect.left));
    const y = Math.min(window.innerHeight - 1, Math.max(1, rect.bottom + 4));
    let element = document.elementFromPoint(x, y);
    while (element && element !== document.body) {
      if (element.matches?.(BLOCK_SELECTOR)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function floatButton() {
    let button = document.querySelector('.qt-float');
    if (button) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'qt-float';
    button.textContent = '译';
    button.title = '翻译本页（Alt+Shift+T）';
    button.addEventListener('click', () => {
      if (button.dataset.busy === '1') clearPage();
      else translatePage();
    });
    document.documentElement.appendChild(button);
    return button;
  }

  function syncFloatButton() {
    const existing = document.querySelector('.qt-float');
    if (!settings.showFloatButton) {
      existing?.remove();
      return;
    }
    floatButton();
  }

  function blocks() {
    const seen = new Set();
    const list = [];
    for (const element of document.querySelectorAll(BLOCK_SELECTOR)) {
      const block = element;
      if (block.parentElement?.closest(BLOCK_SELECTOR)) continue;
      if (seen.has(block)) continue;
      seen.add(block);
      list.push(block);
    }
    return list;
  }

  async function translatePage() {
    const minWords = Number(settings.shortTextMinWords) || 4;
    const targets = blocks().filter(
      (block) => eligible(block, minWords) && !(panelByBlock.get(block)?.isConnected),
    );
    if (targets.length === 0) {
      toast('没有找到可翻译的段落');
      return;
    }
    abortPage = false;
    const button = floatButton();
    button.dataset.busy = '1';
    button.title = '停止翻译';
    let done = 0;
    const total = targets.length;

    // 每批最多 4 段、约 6000 字符；网页版引擎只能串行，一段一批。
    const groups = [];
    if (settings.engine === 'web') {
      for (const block of targets) groups.push([block]);
    } else {
      let group = [];
      let groupChars = 0;
      for (const block of targets) {
        const length = (block.textContent || '').length;
        if (group.length >= 4 || (group.length > 0 && groupChars + length > 6000)) {
          groups.push(group);
          group = [];
          groupChars = 0;
        }
        group.push(block);
        groupChars += length;
      }
      if (group.length > 0) groups.push(group);
    }

    for (const current of groups) {
      if (abortPage) break;
      button.textContent = `${done}/${total}`;
      try {
        if (settings.engine === 'web') {
          await translatePayload(blockPayload(current[0]), current[0]);
        } else {
          await translateBatch(current);
        }
      } catch {
        // 单批失败不阻塞其余批次，面板内可点重试。
      }
      done += current.length;
      button.textContent = `${done}/${total}`;
    }
    button.dataset.busy = '0';
    button.textContent = '译';
    button.title = '翻译本页（Alt+Shift+T）';
    if (!abortPage) toast(`已翻译 ${done} 段`);
  }

  function clearPage() {
    abortPage = true;
    for (const [requestId] of pending) {
      chrome.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {});
    }
    for (const panel of document.querySelectorAll('.qt-panel')) panel.remove();
    const button = document.querySelector('.qt-float');
    if (button) {
      button.dataset.busy = '0';
      button.textContent = '译';
      button.title = '翻译本页（Alt+Shift+T）';
    }
    toast('已清除译文');
  }

  document.addEventListener(
    'mouseover',
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(OWN_UI)) {
        clearTimeout(hoverTimer);
        clearTimeout(prefetchTimer);
        return;
      }
      const block = event.target.closest(BLOCK_SELECTOR);
      if (!block || insideOwnUI(block)) return;
      if (panelByBlock.get(block)?.isConnected) return;
      if (!eligible(block, Number(settings.shortTextMinWords) || 4)) return;
      hoverBlock = block;
      showHoverButton(block);
      schedulePrefetch(block);
      clearTimeout(hoverTimer);
    },
    true,
  );

  document.addEventListener(
    'mouseout',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const block = event.target.closest(BLOCK_SELECTOR);
      if (!block) return;
      const related = event.relatedTarget;
      if (related instanceof Element && related.closest(OWN_UI)) return;
      clearTimeout(hoverTimer);
      clearTimeout(prefetchTimer);
      hoverTimer = setTimeout(hideHoverButton, 260);
    },
    true,
  );

  document.addEventListener('mousedown', (event) => {
    if (event.target instanceof Element && event.target.closest(OWN_UI)) return;
    hideSelectionButton();
  });

  document.addEventListener('mouseup', (event) => {
    if (event.target instanceof Element && event.target.closest(OWN_UI)) return;
    if (event.button !== 0) return;
    setTimeout(() => {
      const info = selectionPayload();
      if (!info) return;
      if (words(info.text) < 1) return;
      showSelectionButton(info);
    }, 10);
  });

  window.addEventListener('scroll', hideHoverButton, { passive: true });

  window.addEventListener(
    'resize',
    () => {
      clearTimeout(panelResizeTimer);
      panelResizeTimer = setTimeout(() => {
        for (const panel of document.querySelectorAll('.qt-panel')) syncPanelWidth(panel);
      }, 120);
    },
    { passive: true },
  );

  chrome.runtime.onMessage.addListener((message) => {
    const type = message?.type;
    if (type === 'translate-page') {
      translatePage();
      return;
    }
    if (type === 'clear-page') {
      clearPage();
      return;
    }
    if (type === 'translate-selection') {
      const text = String(message.text || '').trim();
      if (!text) return;
      const anchor = nearestBlock({ left: 40, bottom: 40 }) || document.body;
      translatePayload({ text, tokens: [] }, anchor);
      return;
    }
    if (type === 'tr-snapshot') {
      const record = pending.get(message.requestId);
      if (!record) return;
      record.raw = String(message.text || '');
      if (record.kind === 'batch') scheduleBatchRender(record);
      else scheduleRender(record);
      return;
    }
    if (type === 'tr-delta') {
      const record = pending.get(message.requestId);
      if (!record) return;
      record.raw += message.text;
      if (record.kind === 'batch') scheduleBatchRender(record);
      else scheduleRender(record);
      return;
    }
    if (type === 'tr-done') {
      const record = pending.get(message.requestId);
      if (record?.kind === 'batch') finishBatch(message.requestId, 'done', null, message);
      else finishPanel(message.requestId, 'done', null, message);
      return;
    }
    if (type === 'tr-error') {
      const record = pending.get(message.requestId);
      if (record?.kind === 'batch') finishBatch(message.requestId, 'error', message.error);
      else finishPanel(message.requestId, 'error', message.error);
      return;
    }
    if (type === 'tr-cancelled') {
      const record = pending.get(message.requestId);
      if (record?.kind === 'batch') finishBatch(message.requestId, 'cancelled');
      else finishPanel(message.requestId, 'cancelled');
      return;
    }
    if (type === 'tr-settings-changed') {
      loadSettings();
    }
  });

  function loadSettings() {
    chrome.runtime
      .sendMessage({ type: 'get-settings' })
      .then((response) => {
        if (!response?.settings) return;
        settings.engine = response.settings.engine === 'web' ? 'web' : 'api';
        settings.cacheEnabled = response.settings.cacheEnabled === true;
        settings.shortTextMinWords = response.settings.shortTextMinWords || 4;
        settings.showFloatButton = response.settings.showFloatButton !== false;
        settings.hoverPrefetch = response.settings.hoverPrefetch !== false;
        settings.hoverPrefetchDelayMs = Number(response.settings.hoverPrefetchDelayMs) || 350;
        syncFloatButton();
      })
      .catch(() => {});
  }

  loadSettings();
})();
