// QYZY·translator · DeepSeek 网页版桥接（实验性）
// 在 chat.deepseek.com 中自动填入提示词、发送、抓取回复并回传。
(() => {
  if (window.__qyzyWebBridge) return;
  window.__qyzyWebBridge = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function composer() {
    const list = [...document.querySelectorAll('div[contenteditable="true"], textarea')].filter(
      visible,
    );
    list.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    return list[0] || null;
  }

  function buttonCandidates() {
    return [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  }

  function sendButton() {
    for (const button of buttonCandidates()) {
      const text = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${
        button.textContent || ''
      }`.toLowerCase();
      if (text.includes('发送') || text.includes('send')) return button;
    }
    const input = composer();
    if (!input) return null;
    let container = input.closest('form');
    if (!container) container = input.parentElement?.parentElement || input.parentElement;
    if (!container) return null;
    const candidates = [...container.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter((button) => button.querySelector('svg'));
    return candidates[candidates.length - 1] || null;
  }

  function setComposerText(input, text) {
    input.focus();
    if (input.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    try {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      document.execCommand('selectAll', false, null);
    }
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      input.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    }
  }

  function composerText() {
    const input = composer();
    if (!input) return '';
    return input.tagName === 'TEXTAREA' ? input.value : input.innerText || '';
  }

  function clickSend() {
    const button = sendButton();
    if (button) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      button.click();
      return true;
    }
    const input = composer();
    if (!input) return false;
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  }

  function disableThinking() {
    const candidates = [...document.querySelectorAll('button, [role="button"], div')]
      .filter(visible)
      .filter((element) => {
        const text = (element.textContent || '').trim();
        return text.includes('深度思考') && text.length < 12;
      })
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const target = candidates[0];
    if (!target) return;
    const className = String(target.className || '');
    const active =
      target.getAttribute('aria-pressed') === 'true' ||
      /active|selected|checked/i.test(className) ||
      Boolean(target.querySelector('[class*="active"], [class*="selected"]'));
    if (active) target.click();
  }

  function markdownBlocks() {
    const all = [...document.querySelectorAll('.ds-markdown, [class*="markdown"]')].filter(visible);
    return all.filter(
      (element) => !all.some((other) => other !== element && other.contains(element)),
    );
  }

  function stopVisible() {
    return buttonCandidates().some((button) => {
      const text = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
      return /停止|stop/i.test(text) && text.length < 20;
    });
  }

  async function waitForReply(beforeCount, beforeText, prompt, webId) {
    const started = Date.now();
    const promptPrefix = prompt ? prompt.trim().slice(0, 30) : '';
    let lastText = '';
    let stableSince = 0;
    let lastSnapshotAt = 0;
    while (Date.now() - started < 150000) {
      await sleep(400);
      const blocks = markdownBlocks();
      let text = '';
      if (blocks.length > beforeCount) {
        // 一条回复可能被拆成多个 markdown 块，按顺序全部拼接，而不是只取最后一块。
        text = blocks
          .slice(beforeCount)
          .map((block) => (block.innerText || '').trim())
          .filter((part) => part && !(promptPrefix && part.startsWith(promptPrefix)))
          .join('\n\n');
      } else if (blocks.length > 0) {
        const last = (blocks[blocks.length - 1].innerText || '').trim();
        if (last && last !== beforeText && !(promptPrefix && last.startsWith(promptPrefix))) {
          text = last;
        }
      }
      if (text) {
        if (Date.now() - lastSnapshotAt > 500) {
          lastSnapshotAt = Date.now();
          chrome.runtime.sendMessage({ type: 'web-snapshot', webId, text }).catch(() => {});
        }
        if (text !== lastText) {
          lastText = text;
          stableSince = Date.now();
        } else {
          const idle = Date.now() - stableSince;
          if ((idle > 1500 && !stopVisible()) || idle > 5000) {
            return lastText;
          }
        }
      } else if (blocks.length > beforeCount) {
        stableSince = 0;
      }
    }
    throw new Error('等待 DeepSeek 回复超时（150 秒）');
  }

  let chain = Promise.resolve();

  function findNewChatButton() {
    const all = [...document.querySelectorAll('button, a, [role="button"], div, span')].filter(visible);
    const byLabel = all.find((element) => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`.trim();
      return /新建对话|新对话|new chat/i.test(label);
    });
    if (byLabel) return byLabel;
    return (
      all.find((element) => {
        const text = (element.textContent || '').trim();
        return /^(新建对话|新对话|new chat)$/i.test(text);
      }) || null
    );
  }

  function currentConversationLink() {
    const links = [...document.querySelectorAll('a[href*="/chat/"]')].filter(visible);
    const path = location.pathname;
    const exact = links.find((link) => {
      try {
        return new URL(link.href, location.origin).pathname === path;
      } catch {
        return false;
      }
    });
    if (exact) return exact;
    return (
      links.find((link) => {
        const className = String(link.className || '');
        return (
          /active|selected|current/i.test(className) ||
          link.getAttribute('aria-current') === 'page'
        );
      }) || null
    );
  }

  async function deleteCurrentConversation() {
    const active = currentConversationLink();
    if (!active) return false;
    active.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(250);
    const buttons = [...active.querySelectorAll('button, [role="button"]')].filter(visible);
    const more =
      buttons.find((button) =>
        /更多|more|\.\.\.|…/i.test(
          `${button.getAttribute('aria-label') || ''}${button.textContent || ''}`,
        ),
      ) ||
      buttons[0] ||
      [...document.querySelectorAll('button, [role="button"]')].find((button) =>
        /更多|more/i.test(button.getAttribute('aria-label') || ''),
      );
    if (!more) return false;
    more.click();
    await sleep(350);
    const menuItems = [...document.querySelectorAll('[role="menuitem"], button, div')]
      .filter(visible)
      .filter((element) => {
        const text = (element.textContent || '').trim();
        if (!/删除/.test(text)) return false;
        if (/全部|所有/.test(text)) return false;
        return text.length < 10;
      });
    const deleteItem = menuItems[menuItems.length - 1];
    if (!deleteItem) return false;
    deleteItem.click();
    await sleep(400);
    const confirmButtons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter((button) => {
        const text = (button.textContent || '').trim();
        return /^(删除|确认)/.test(text) && text.length < 8;
      });
    if (confirmButtons.length > 0) {
      confirmButtons[confirmButtons.length - 1].click();
      await sleep(800);
    }
    return true;
  }

  async function startNewChat() {
    try {
      await deleteCurrentConversation();
    } catch {
      // 删除失败不阻塞新开对话。
    }
    const button = findNewChatButton();
    if (button) {
      button.click();
      await sleep(1200);
      return true;
    }
    const home = [...document.querySelectorAll('a[href="/"]')].filter(visible)[0];
    if (home) {
      home.click();
      await sleep(1200);
      return true;
    }
    return false;
  }

  async function runTranslation({ webId, prompt }) {
    if (!composer()) {
      throw new Error('找不到输入框：请确认已打开 chat.deepseek.com 并登录');
    }
    disableThinking();
    await sleep(200);
    const beforeBlocks = markdownBlocks();
    const beforeCount = beforeBlocks.length;
    const beforeText = beforeBlocks.length
      ? (beforeBlocks[beforeBlocks.length - 1].innerText || '').trim()
      : '';
    setComposerText(composer(), prompt);
    await sleep(250);
    if (!composerText().trim()) throw new Error('未能把提示词写入输入框');
    if (!clickSend()) throw new Error('发送按钮不可用');
    await sleep(1200);
    if (composerText().includes(prompt.slice(0, 20))) {
      throw new Error('提示词仍在输入框中，发送可能失败');
    }
    const text = await waitForReply(beforeCount, beforeText, prompt, webId);
    chrome.runtime.sendMessage({ type: 'web-done', webId, text }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'web-ping') {
      sendResponse({ ok: Boolean(composer()), url: location.href });
      return;
    }
    if (message?.type === 'web-new-chat') {
      chain = chain.then(async () => {
        const ok = await startNewChat();
        sendResponse({ ok });
      });
      return true;
    }
    if (message?.type === 'web-translate') {
      sendResponse({ ok: true });
      chain = chain
        .then(() => runTranslation(message))
        .catch((error) => {
          chrome.runtime
            .sendMessage({
              type: 'web-error',
              webId: message.webId,
              error: String(error?.message || error),
            })
            .catch(() => {});
        });
    }
  });
})();

