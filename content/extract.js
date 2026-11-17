// 抓取脚本：每次点击都会重新注入，整体包在 IIFE 里，重复注入不会报错。
// 对外只暴露 window.__llmCopy = { run(mode), extract(mode) }
//   mode: auto | selection | article | page | form
(() => {
  const TOAST_ID = '__llm-copy-toast';

  /* ============================================================
   * 1. HTML → Markdown 转换器
   * ============================================================ */

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'button', 'input', 'select', 'textarea', 'option', 'datalist', 'meta', 'link', 'head',
    'video', 'audio', 'map', 'source',
  ]);
  // 段落级：前后空一行
  const PARA_TAGS = new Set([
    'p', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'form',
    'fieldset', 'details', 'dl', 'address', 'table',
  ]);
  // 无法计算样式时（选中内容是脱离文档的副本），按标签判断块级
  const BLOCK_TAGS = new Set([
    ...PARA_TAGS, 'div', 'li', 'ul', 'ol', 'dd', 'dt', 'figcaption', 'summary', 'legend',
    'tr', 'tbody', 'thead', 'tfoot', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote',
  ]);
  const SR_ONLY = /(^|\s)(sr-only|screenreader-only|screen-reader-only|screen-reader-text|visually-hidden|visuallyhidden|ui-helper-hidden-accessible|offscreen)(\s|$)|hiddenVisually/;
  const IND = '\u0001'; // 列表缩进占位
  // 末尾会单独附上「表单字段」时，正文里不再重复输出 label 文字
  let dropLabels = false;
  const PRE = '\u0002'; // 代码块占位

  function isSrOnly(el) {
    const c = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    return c && SR_ONLY.test(c);
  }

  function isVisible(el) {
    if (el.hidden) return false;
    if (!el.checkVisibility) return true;
    if (el.checkVisibility({ visibilityProperty: true })) return true;
    // display:contents 没有盒子，但子元素可见
    return getComputedStyle(el).display === 'contents';
  }

  function isChrome(el, tag) {
    if (tag === 'nav' || tag === 'footer' || tag === 'aside') return true;
    if (tag === 'header') return !el.closest('article, main, [role="main"]');
    const role = el.getAttribute('role');
    return role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary' || role === 'search';
  }

  /**
   * opt.vis       是否按真实可见性过滤（脱离文档的选中副本要传 false）
   * opt.dropChrome 是否去掉导航/页脚/侧栏
   * opt.img       'alt'：有 alt 才输出 [图片: alt]；'mark'：无 alt 也输出 [图片]
   * opt.skip      额外跳过的 CSS 选择器
   */
  function md(root, opt = {}) {
    if (!root) return '';
    const ctx = { pres: [], vis: opt.vis !== false, dropChrome: !!opt.dropChrome, img: opt.img || 'alt', skip: opt.skip || null };
    const out = conv(root, ctx, { pre: false }, true);
    return finalize(out, ctx);
  }

  function kids(node, ctx, st) {
    let s = '';
    for (const c of node.childNodes) s += conv(c, ctx, st);
    return s;
  }

  function conv(node, ctx, st, isRoot) {
    if (node.nodeType === 3) return st.pre ? node.data : node.data.replace(/[\s ]+/g, ' ');
    if (node.nodeType === 11) return kids(node, ctx, st);
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.localName;
    if (SKIP_TAGS.has(tag) || el.id === TOAST_ID) return '';
    if (isSrOnly(el)) return '';
    if (ctx.vis && !isVisible(el)) return '';
    if (!isRoot && ctx.dropChrome && isChrome(el, tag)) return '';
    if (ctx.skip && el.matches(ctx.skip)) return '';
    if (dropLabels && tag === 'label') return '';

    switch (tag) {
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const t = oneLine(kids(el, ctx, st));
        return t ? `\n\n${'#'.repeat(+tag[1])} ${t}\n\n` : '';
      }
      case 'pre': {
        const code = el.textContent.replace(/\s+$/, '');
        if (!code.trim()) return '';
        const lang = ((el.querySelector('code')?.className || el.className || '').match(/language-([\w+#-]+)/) || [])[1] || '';
        ctx.pres.push('```' + lang + '\n' + code + '\n```');
        return `\n\n${PRE}${ctx.pres.length - 1}${PRE}\n\n`;
      }
      case 'code': {
        if (st.pre) return el.textContent;
        const t = el.textContent.replace(/\s+/g, ' ');
        return t.trim() ? '`' + t + '`' : '';
      }
      case 'strong': case 'b':
        return wrapInline(kids(el, ctx, st), '**');
      case 'a': return link(el, ctx, st);
      case 'img': return img(el, ctx);
      case 'ul': case 'ol': return list(el, ctx, st, tag === 'ol');
      case 'table': return table(el, ctx, st);
      case 'blockquote': {
        const inner = tidy(kids(el, ctx, st));
        return inner ? '\n\n' + inner.split('\n').map((l) => '> ' + l).join('\n') + '\n\n' : '';
      }
      case 'dt': {
        const t = oneLine(kids(el, ctx, st));
        return t ? `\n\n**${t}**\n` : '';
      }
      case 'slot': {
        const nodes = el.assignedNodes ? el.assignedNodes({ flatten: true }) : [];
        if (nodes.length) return nodes.map((n) => conv(n, ctx, st)).join('');
        break;
      }
    }

    const inner = el.shadowRoot ? kids(el.shadowRoot, ctx, st) : kids(el, ctx, st);
    if (isRoot) return inner;
    if (PARA_TAGS.has(tag)) return '\n\n' + inner + '\n\n';
    if (isBlock(el, tag, ctx)) return '\n' + inner + '\n';
    return inner;
  }

  function isBlock(el, tag, ctx) {
    if (!ctx.vis) return BLOCK_TAGS.has(tag);
    const d = getComputedStyle(el).display;
    return !(d.startsWith('inline') || d === 'contents');
  }

  function oneLine(s) { return s.replace(/\s+/g, ' ').trim(); }

  function wrapInline(s, mark) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m[2] || m[2].includes('\n')) return s;
    return m[1] + mark + m[2] + mark + m[3];
  }

  function link(el, ctx, st) {
    const t = kids(el, ctx, st);
    const plain = oneLine(t);
    const raw = el.getAttribute('href') || '';
    const abs = el.href || '';
    if (!plain || t.includes('\n') || !/^https?:/i.test(abs) || raw.startsWith('#')) return t;
    if (plain === abs || plain === abs.replace(/^https?:\/\//, '')) return abs;
    const m = t.match(/^(\s*)/);
    return m[1] + `[${plain}](${abs})` + (/\s$/.test(t) ? ' ' : '');
  }

  function img(el, ctx) {
    const emoji = el.getAttribute('data-stringify-emoji');
    if (emoji) return emoji;
    const alt = (el.getAttribute('alt') || '').trim();
    if (/^:[\w+\-~]+:$/.test(alt) || el.classList.contains('emoji') || /^\p{Extended_Pictographic}/u.test(alt)) return alt;
    if (alt) return `[图片: ${alt}]`;
    return ctx.img === 'mark' ? '[图片]' : '';
  }

  function list(el, ctx, st, ordered) {
    const items = [];
    let n = ordered ? parseInt(el.getAttribute('start'), 10) || 1 : 0;
    for (const c of el.children) {
      if (c.localName !== 'li') {
        const t = tidy(conv(c, ctx, st));
        if (t) items.push(t);
        continue;
      }
      if (isSrOnly(c) || (ctx.vis && !isVisible(c))) continue;
      const body = tidy(kids(c, ctx, st)).replace(/\n{2,}/g, '\n');
      if (!body) continue;
      items.push((ordered ? `${n++}.` : '-') + ' ' + body.replace(/\n/g, '\n' + IND));
    }
    return items.length ? '\n\n' + items.join('\n') + '\n\n' : '';
  }

  function table(el, ctx, st) {
    // 布局用的嵌套表格：直接当普通块处理
    if (el.querySelector('table')) return '\n\n' + kids(el, ctx, st) + '\n\n';
    const rows = [...el.rows].filter((r) => !ctx.vis || isVisible(r));
    const grid = rows
      .map((r) => [...r.cells].map((c) => tidy(kids(c, ctx, st)).replace(/\n+/g, ' <br> ').replace(/\|/g, '\\|')))
      .filter((r) => r.some((c) => c));
    if (!grid.length) return '';
    const cols = Math.max(...grid.map((r) => r.length));
    if (cols <= 1) return '\n\n' + grid.map((r) => r.join(' ')).join('\n') + '\n\n';
    const pad = (r) => { while (r.length < cols) r.push(''); return r; };
    const line = (r) => '| ' + pad(r).join(' | ') + ' |';
    const cap = el.caption ? oneLine(el.caption.textContent) : '';
    const out = [line(grid[0]), '|' + ' --- |'.repeat(cols), ...grid.slice(1).map(line)];
    return '\n\n' + (cap ? `**${cap}**\n\n` : '') + out.join('\n') + '\n\n';
  }

  function tidy(s) {
    return s
      .split('\n')
      .map((l) => {
        if (!l.replace(/[\u0001\s]/g, '')) return '';
        return l.replace(/^(\u0001*)[ \t]+/, '$1').replace(/[ \t]+$/, '').replace(/(\S)[ \t]{2,}/g, '$1 ');
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function finalize(s, ctx) {
    return tidy(s)
      .replace(/\u0001/g, '  ')
      .replace(/\u0002(\d+)\u0002/g, (_, i) => ctx.pres[+i]);
  }

  /* ============================================================
   * 2. 通用网页：挑选正文区域
   * ============================================================ */

  function textLen(el) { return (el?.innerText || '').trim().length; }

  function pickMain() {
    const bodyLen = textLen(document.body) || 1;
    const byLen = (a, b) => textLen(b) - textLen(a);
    const main = [...document.querySelectorAll('main, [role="main"]')].filter(isVisible).sort(byLen)[0];
    if (main && textLen(main) >= bodyLen * 0.3) return main;
    const arts = [...document.querySelectorAll('article')].filter((a) => isVisible(a) && textLen(a) > 200);
    if (arts.length === 1 && textLen(arts[0]) >= bodyLen * 0.3) return arts[0];
    return document.body;
  }

  function extractArticle() {
    return { title: document.title, label: '网页正文', body: md(pickMain(), { dropChrome: true }), withForm: true };
  }

  function extractPage() {
    return { title: document.title, label: '整页', body: md(document.body), withForm: false };
  }

  function extractSelection() {
    const sel = window.getSelection();
    const plain = sel ? sel.toString().trim() : '';
    if (!plain) throw new Error('没有选中任何内容');
    const div = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) div.append(sel.getRangeAt(i).cloneContents());
    const body = md(div, { vis: false, img: 'mark' }) || plain;
    return { title: document.title, label: '选中内容', body, withForm: false };
  }

  /* ============================================================
   * 3. 表单字段
   * ============================================================ */

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function labelText(label) {
    const c = label.cloneNode(true);
    c.querySelectorAll('input, select, textarea, button, .sr-only, .screenreader-only').forEach((x) => x.remove());
    return clean(c.textContent);
  }

  function ariaName(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = clean(ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
      if (t) return t;
    }
    return clean(el.getAttribute('aria-label'));
  }

  function fieldLabel(el) {
    const fromLabels = el.labels ? clean([...el.labels].map(labelText).join(' ')) : '';
    if (fromLabels) return fromLabels;
    const a = ariaName(el);
    if (a) return a;
    const wrap = el.closest('label');
    if (wrap && labelText(wrap)) return labelText(wrap);
    const ph = clean(el.getAttribute('placeholder') || el.getAttribute('title'));
    if (ph) return ph;
    // 往上找最近的一段短文字
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++) {
      let p = n.previousElementSibling;
      while (p) {
        // 碰到别的字段（或它的 label）就停，避免借用上一个字段的名字
        if (p.matches('label, input, select, textarea') || p.querySelector('input, select, textarea')) { n = null; break; }
        const t = clean(p.innerText);
        if (t) return t.length <= 120 ? t : t.slice(0, 120) + '…';
        p = p.previousElementSibling;
      }
      if (!n) break;
      n = n.parentElement;
    }
    return clean(el.getAttribute('name') || el.id) || '(未命名字段)';
  }

  // 单选组 / 多选组的问题文字
  function groupLabel(el) {
    const lg = el.closest('fieldset')?.querySelector('legend');
    if (lg && clean(lg.innerText)) return clean(lg.innerText);
    const g = el.closest('[role="radiogroup"], [role="group"]');
    if (g && ariaName(g)) return ariaName(g);
    const box = el.closest('.question, [role="listitem"], .form-group, .form-field, .field');
    const h = box?.querySelector('[role="heading"], .question_text, .question-text, h1, h2, h3, h4, h5, h6, legend');
    if (h && clean(h.innerText)) return clean(h.innerText).slice(0, 200);
    return clean(el.getAttribute('name')) || '';
  }

  function isRequired(el, label) {
    return el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);
  }

  function fieldVisible(el) {
    if (isVisible(el)) return true;
    // 自定义样式的单选/多选框经常把原生 input 藏起来，只要 label 可见就算
    return !!(el.labels && [...el.labels].some(isVisible));
  }

  function collectFields() {
    const sel = [
      'input', 'select', 'textarea', '[contenteditable="true"]', '[contenteditable=""]',
      '[role="textbox"]', '[role="combobox"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]', '[role="listbox"]',
    ].join(',');
    const fields = [];
    const groups = new Map(); // 单选组
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest(`#${TOAST_ID}, nav, [role="search"], [role="navigation"]`)) continue;
      const tag = el.localName;
      const native = tag === 'input' || tag === 'select' || tag === 'textarea';
      if (!native && el.querySelector('input, select, textarea')) continue; // 交给内部原生控件
      if (!native && el.parentElement?.closest('[contenteditable="true"], [contenteditable=""]')) continue;
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (!fieldVisible(el)) continue;

      const role = el.getAttribute('role');
      // —— 单选 ——
      if (type === 'radio' || role === 'radio') {
        const container = el.closest('[role="radiogroup"]');
        const key = container || (el.name ? [...document.forms].indexOf(el.form) + '|' + el.name : el);
        let g = groups.get(key);
        if (!g) {
          g = { kind: 'radio', label: groupLabel(el) || fieldLabel(el), options: [], required: false };
          groups.set(key, g);
          fields.push(g);
        }
        const checked = type === 'radio' ? el.checked : el.getAttribute('aria-checked') === 'true';
        const opt = type === 'radio' ? fieldLabel(el) : ariaName(el) || clean(el.innerText);
        g.options.push({ label: opt, checked });
        g.required = g.required || isRequired(el, '');
        continue;
      }

      const label = fieldLabel(el);
      const f = { label: label.replace(/[\s:：*]+$/, ''), required: isRequired(el, label) };
      if (type === 'checkbox' || role === 'checkbox' || role === 'switch') {
        const checked = type === 'checkbox' ? el.checked : el.getAttribute('aria-checked') === 'true';
        const gl = groupLabel(el);
        if (gl && gl !== f.label) f.label = `${gl} › ${f.label}`;
        f.value = checked ? '☑ 已勾选' : '☐ 未勾选';
      } else if (type === 'password') {
        f.value = '（密码已隐藏）';
      } else if (type === 'file') {
        f.value = el.files?.length ? [...el.files].map((x) => x.name).join(', ') : '（未选择文件）';
      } else if (tag === 'select') {
        f.value = [...el.selectedOptions].map((o) => clean(o.text)).join(', ') || '（未选择）';
        const opts = [...el.options].map((o) => clean(o.text)).filter(Boolean);
        f.options = opts.length <= 15 ? opts.join(' / ') : `共 ${opts.length} 项`;
      } else if (role === 'listbox') {
        f.value = [...el.querySelectorAll('[aria-selected="true"]')].map((o) => clean(o.innerText)).join(', ') || '（未选择）';
      } else if (native) {
        f.value = el.value;
      } else {
        f.value = el.getAttribute('aria-valuetext') || el.innerText;
      }
      fields.push(f);
    }
    return fields;
  }

  function formatFields(fields) {
    return fields
      .map((f) => {
        const req = f.required ? '（必填）' : '';
        if (f.kind === 'radio') {
          const picked = f.options.filter((o) => o.checked).map((o) => o.label).join(', ') || '（未选择）';
          const opts = f.options.map((o) => o.label).join(' / ');
          return `- **${f.label || '单选'}**${req}: ${picked}\n  选项: ${opts}`;
        }
        let v = (f.value ?? '').toString().trim();
        if (!v) v = '（空）';
        else if (v.includes('\n')) v = '\n' + v.split('\n').map((l) => '  > ' + l).join('\n');
        return `- **${f.label}**${req}: ${v}` + (f.options ? `\n  选项: ${f.options}` : '');
      })
      .join('\n');
  }

  function extractForm() {
    const fields = collectFields();
    if (!fields.length) throw new Error('页面上没有找到表单字段');
    return { title: document.title, label: '表单', body: `## 表单字段（共 ${fields.length} 项）\n\n` + formatFields(fields), withForm: false };
  }

  /* ============================================================
   * 4. 对话：Discord / Slack
   * ============================================================ */

  function fmtTime(d) {
    if (!d || isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const ymd = d.getFullYear() === now.getFullYear() ? `${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `${ymd} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // items: { divider } 或 { author, ts(Date), reply, body, extras[] }
  function formatChat(items) {
    const out = [];
    let last = null;
    for (const it of items) {
      if (it.divider) { out.push(`\n—— ${it.divider} ——\n`); last = null; continue; }
      const author = it.author || last?.author || '（未知）';
      const gap = it.ts && last?.ts ? it.ts - last.ts : 0;
      const newHead = !last || author !== last.author || it.reply || gap > 10 * 60e3;
      let b = '';
      if (newHead) b += `\n**${author}**${it.ts ? ' · ' + fmtTime(it.ts) : ''}\n`;
      if (it.reply) b += `> ↪ 回复 ${it.reply}\n`;
      if (it.body) b += it.body + '\n';
      for (const x of it.extras || []) if (x) b += x + '\n';
      out.push(b);
      last = { author, ts: it.ts || last?.ts };
    }
    return out.join('').trim();
  }

  function chatResult(label, title, groups) {
    const count = groups.reduce((n, g) => n + g.items.filter((i) => !i.divider).length, 0);
    if (!count) return null;
    const body = groups
      .filter((g) => g.items.length)
      .map((g) => (groups.length > 1 ? `## ${g.name}\n\n` : '') + formatChat(g.items))
      .join('\n\n');
    return { title, label, body, count, withForm: false };
  }

  // ---------- Discord ----------
  function discordMessage(li) {
    const id = li.id.split('-').pop();
    const inReply = (e) => !!e.closest('[id^="message-reply-context-"]');
    const head = [...li.querySelectorAll('h3')].find((h) => !inReply(h));
    const author = clean(head?.querySelector('[class*="username"]')?.textContent) || null;
    const timeEl = [...li.querySelectorAll('time[datetime]')].find((t) => !inReply(t));
    const ts = timeEl ? new Date(timeEl.getAttribute('datetime')) : null;

    let reply = null;
    const rc = li.querySelector('[id^="message-reply-context-"]');
    if (rc) {
      const ra = clean(rc.querySelector('[class*="username"]')?.textContent).replace(/^@/, '');
      let rt = clean((rc.querySelector('[class*="repliedTextContent"]') || rc).textContent);
      if (ra && rt.startsWith('@' + ra)) rt = rt.slice(ra.length + 1).trim();
      if (rt.length > 80) rt = rt.slice(0, 80) + '…';
      reply = ra ? `${ra}: ${rt}` : rt;
    }

    const content =
      li.querySelector('#message-content-' + CSS.escape(id)) ||
      [...li.querySelectorAll('[id^="message-content-"]')].find((e) => !inReply(e));
    const body = content ? md(content, { img: 'mark' }) : '';

    const extras = [];
    const acc = li.querySelector('#message-accessories-' + CSS.escape(id)) || li.querySelector('[id^="message-accessories-"]');
    if (acc) {
      const a = md(acc, { img: 'mark', skip: '[class*="reactions"], [class*="reaction_"]' });
      if (a) extras.push(a);
    }
    const reactions = [...li.querySelectorAll('[class*="reaction_"]')]
      .map((r) => {
        const im = r.querySelector('img');
        const emoji = im ? im.getAttribute('alt') : clean(r.querySelector('[class*="emoji"]')?.textContent);
        const cnt = clean(r.querySelector('[class*="reactionCount"]')?.textContent);
        return emoji ? `${emoji} ${cnt}`.trim() : '';
      })
      .filter(Boolean);
    if (reactions.length) extras.push(`（反应: ${reactions.join(' · ')}）`);

    if (!body && !extras.length) {
      // 系统消息（加入频道、置顶等）
      const t = clean(li.innerText);
      return t ? { author: '系统', ts, body: t } : null;
    }
    return { author, ts, reply, body, extras };
  }

  function extractDiscord() {
    let lists = [...document.querySelectorAll('ol[data-list-id="chat-messages"]')];
    const groups = (lists.length ? lists : [document.body]).map((ol, i) => {
      const nodes = lists.length ? [...ol.children] : [...document.querySelectorAll('li[id^="chat-messages-"]')];
      const items = [];
      for (const n of nodes) {
        if (n.matches('li[id^="chat-messages-"]')) {
          const m = discordMessage(n);
          if (m) items.push(m);
        } else if (n.getAttribute('role') === 'separator' || /divider/i.test(n.className)) {
          const t = clean(n.textContent);
          if (t && !/^(new|新)/i.test(t)) items.push({ divider: t });
        }
      }
      return { name: i === 0 ? '频道消息' : '线程 / 侧栏', items };
    });
    const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/^Discord\s*\|\s*/, '');
    return chatResult('Discord 对话', `Discord · ${title}`, groups);
  }

  // ---------- Slack ----------
  function slackMessage(msg) {
    const author = clean(msg.querySelector('[data-qa="message_sender_name"], .c-message__sender_button, .c-message__sender')?.textContent) || null;
    const tsAttr = msg.querySelector('[data-ts]')?.getAttribute('data-ts');
    const ts = tsAttr ? new Date(parseFloat(tsAttr) * 1000) : null;
    const bodyEl = msg.querySelector('.c-message_kit__blocks') || msg.querySelector('[data-qa="message-text"], .p-rich_text_block, .c-message__body');
    const body = bodyEl ? md(bodyEl, { img: 'mark' }) : '';
    const extras = [];
    for (const s of ['.c-message_kit__attachments', '.c-message_kit__files', '.c-files_container']) {
      const e = msg.querySelector(s);
      if (e && !bodyEl?.contains(e)) {
        const t = md(e, { img: 'mark' });
        if (t) extras.push(t);
      }
    }
    const reactions = [...msg.querySelectorAll('.c-reaction')]
      .map((r) => {
        const im = r.querySelector('img');
        const emoji = im ? im.getAttribute('data-stringify-emoji') || im.getAttribute('alt') : '';
        const cnt = clean(r.querySelector('.c-reaction__count')?.textContent);
        return emoji ? `${emoji} ${cnt}`.trim() : '';
      })
      .filter(Boolean);
    if (reactions.length) extras.push(`（反应: ${reactions.join(' · ')}）`);
    const replies = clean(msg.querySelector('.c-message__reply_count, [data-qa="reply_bar_count"]')?.textContent);
    if (replies) extras.push(`（线程: ${replies}）`);
    if (!body && !extras.length) return null;
    return { author, ts, body, extras };
  }

  function extractSlack() {
    const MSG = '.c-message_kit__message, [data-qa="message_container"]';
    const DIV = '.c-message_list__day_divider__label, [data-qa="day_divider_label"]';
    const byList = new Map();
    for (const it of document.querySelectorAll('.c-virtual_list__item')) {
      const msg = it.querySelector(MSG);
      const div = !msg && it.querySelector(DIV);
      if (!msg && !div) continue; // 侧边栏频道列表等
      const list = it.closest('.c-virtual_list') || document.body;
      if (!byList.has(list)) byList.set(list, []);
      const arr = byList.get(list);
      if (msg) {
        const m = slackMessage(msg);
        if (m) arr.push(m);
      } else {
        const t = clean(div.textContent);
        if (t) arr.push({ divider: t });
      }
    }
    const groups = [...byList.entries()].map(([list, items], i) => ({
      name: clean(list.getAttribute('aria-label') || list.closest('[aria-label]')?.getAttribute('aria-label')) || (i === 0 ? '频道消息' : '线程'),
      items,
    }));
    const title = document.title.replace(/\s*[-|]\s*Slack\s*$/i, '');
    return chatResult('Slack 对话', `Slack · ${title}`, groups);
  }

  /* ============================================================
   * 5. Canvas（ASU 等 Instructure Canvas 站点）
   * ============================================================ */

  function extractCanvas() {
    const root = document.querySelector('#content') || document.querySelector('#content-wrapper') || document.querySelector('main, [role="main"]');
    if (!root) return null;
    const crumbs = [...document.querySelectorAll('#breadcrumbs li, nav[aria-label*="readcrumb" i] li')]
      .map((li) => clean(li.innerText))
      .filter(Boolean);
    const body = md(root, { dropChrome: false });
    if (!body) return null;
    return { title: document.title, label: 'Canvas', meta: crumbs.length ? [`课程路径: ${crumbs.join(' › ')}`] : [], body, withForm: true };
  }

  /* ============================================================
   * 6. 调度 + 输出
   * ============================================================ */

  function detectSite() {
    const h = location.hostname;
    if (/(^|\.)discord\.com$/.test(h)) return 'discord';
    if (/(^|\.)slack\.com$/.test(h)) return 'slack';
    if (/instructure\.com$/.test(h) || /^canvas\./.test(h) || document.querySelector('#application.ic-app, body.ic-app, .ic-app')) return 'canvas';
    return 'web';
  }

  const ADAPTERS = { discord: extractDiscord, slack: extractSlack, canvas: extractCanvas };
  const SITE_NAMES = { discord: 'Discord', slack: 'Slack', canvas: 'Canvas' };

  function extract(mode = 'auto') {
    let r;
    if (mode === 'auto' && window.getSelection()?.toString().trim()) mode = 'selection';
    const site = ADAPTERS[mode] ? mode : detectSite();
    // 只有「网页正文 / Canvas」会在末尾附表单字段
    const formPossible = mode === 'article' || (['auto', 'canvas'].includes(mode) && (site === 'web' || site === 'canvas'));
    const fields = formPossible ? collectFields() : [];
    dropLabels = fields.length >= 3;
    try {
      if (mode === 'selection') r = extractSelection();
      else if (mode === 'page') r = extractPage();
      else if (mode === 'form') r = extractForm();
      else if (mode === 'article') r = extractArticle();
      else if (ADAPTERS[site]) {
        // mode 也可以直接传 discord / slack / canvas 强制使用某个适配器（调试用）
        r = ADAPTERS[site]();
        if (!r) {
          // 适配器没抓到东西（多半是网站改版了），退回通用正文，并在标签里提示
          r = extractArticle();
          r.label = `网页正文（${SITE_NAMES[site]} 适配未命中）`;
        }
      } else {
        r = extractArticle();
      }
    } finally {
      dropLabels = false;
    }

    let body = r.body || '';
    if (r.withForm && fields.length >= 3) {
      body += `\n\n## 表单字段（共 ${fields.length} 项）\n\n` + formatFields(fields);
    }
    if (!body.trim()) throw new Error('没有提取到内容');

    const head = [
      `# ${clean(r.title) || location.hostname}`,
      `> 来源: ${location.href}`,
      ...(r.meta || []).map((m) => `> ${m}`),
      `> 抓取时间: ${new Date().toLocaleString('zh-CN', { hour12: false })} · 模式: ${r.label}${r.count ? ` · 共 ${r.count} 条消息` : ''}`,
    ].join('\n');
    const text = head + '\n\n' + body.trim() + '\n';
    return { text, label: r.label, count: r.count || 0 };
  }

  function estimateTokens(s) {
    const cjk = (s.match(/[぀-ヿ㐀-鿿가-힯＀-￯]/g) || []).length;
    return Math.round(cjk + (s.length - cjk) / 4);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* 页面未聚焦等情况，走下面的兜底 */ }
    // 兜底：execCommand('copy')，用捕获阶段的监听器写入，避免网站自己的 copy 处理改掉内容
    const onCopy = (e) => {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('copy', onCopy, true);
    try {
      return document.execCommand('copy');
    } finally {
      window.removeEventListener('copy', onCopy, true);
    }
  }

  function toast(msg, isErr) {
    document.getElementById(TOAST_ID)?.remove();
    const host = document.createElement('div');
    host.id = TOAST_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `<style>
      .t{font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#fff;
         background:${isErr ? '#b91c1c' : '#1f2937'};padding:10px 14px;border-radius:10px;max-width:440px;
         box-shadow:0 8px 28px rgba(0,0,0,.28);opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}
      .t.on{opacity:1;transform:none}</style><div class="t"></div>`;
    const t = sh.querySelector('.t');
    t.textContent = msg;
    document.documentElement.appendChild(host);
    requestAnimationFrame(() => t.classList.add('on'));
    setTimeout(() => { t.classList.remove('on'); setTimeout(() => host.remove(), 250); }, isErr ? 4000 : 2600);
  }

  async function run(mode) {
    let r;
    try {
      r = extract(mode);
    } catch (e) {
      toast('✗ ' + (e.message || e), true);
      return { ok: false, error: String(e.message || e) };
    }
    const ok = await copy(r.text);
    const tokens = estimateTokens(r.text);
    const tok = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
    if (ok) {
      toast(`✓ 已复制 · ${r.label}${r.count ? ` · ${r.count} 条消息` : ''} · ${r.text.length.toLocaleString()} 字 · ≈${tok} tokens`);
    } else {
      toast('✗ 复制到剪贴板失败，请先点一下页面再试', true);
    }
    return { ok, chars: r.text.length, tokens };
  }

  window.__llmCopy = { run, extract };
})();
