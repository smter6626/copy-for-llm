// 后台：处理图标点击、快捷键、右键菜单，把抓取脚本注入当前标签页。

const MENU = [
  ['auto', '自动识别（同点击图标）', ['all']],
  ['selection', '仅复制选中内容', ['selection']],
  ['article', '网页正文', ['all']],
  ['page', '整页全部文字', ['all']],
  ['form', '仅表单字段', ['all']],
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'root', title: '复制给 LLM', contexts: ['all'] });
    for (const [id, title, contexts] of MENU) {
      chrome.contextMenus.create({ id: 'm:' + id, parentId: 'root', title, contexts });
    }
  });
});

// 快捷键 _execute_action 也会触发这里
chrome.action.onClicked.addListener((tab) => run(tab, 'auto'));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith('m:')) run(tab, id.slice(2));
});

async function run(tab, mode) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/extract.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (m) => window.__llmCopy.run(m),
      args: [mode],
    });
    flash(tab.id, !!res?.result?.ok);
  } catch (e) {
    // chrome:// 页、Chrome 应用商店等无法注入脚本
    console.warn('[Copy for LLM]', e);
    flash(tab.id, false);
  }
}

function flash(tabId, ok) {
  const safe = (p) => p && p.catch && p.catch(() => {});
  safe(chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#16a34a' : '#dc2626' }));
  safe(chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' }));
  setTimeout(() => safe(chrome.action.setBadgeText({ tabId, text: '' })), 2500);
}
