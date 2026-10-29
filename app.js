/* =========================================================
   md2card — 把 Markdown 变成一张可以直接发布的长图
   零依赖、零构建。整个应用只有三个状态：内容、主题、比例。

   目录：
     1. 常量与状态
     2. Markdown 解析（约 120 行）
     3. 测量与分页（全项目唯一需要动脑的地方）
     4. 渲染
     5. 导出（DOM → SVG → Canvas → PNG，不引第三方库）
     6. 交互
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 1. 常量与状态 ---------------- */

  const CARD_W = 750;          // 设计稿宽度，固定值，不跟随屏幕
  const PAD_TOP = 68;
  const PAD_BOTTOM = 108;      // 给页脚留的位置
  const GAP = 26;              // 块间距，必须和 card-style 里的 --gap 一致
  const RATIO_H = { '3:4': 1000, '1:1': 750 };
  const SCALE = 2;             // 导出 2x，否则手机上放大就是糊的
  const STORE = { src: 'md2card:src', theme: 'md2card:theme', ratio: 'md2card:ratio' };

  const state = {
    theme: 'paper',
    ratio: '3:4',
    total: 0,
    busy: false
  };

  // 无痕模式下 localStorage 会直接抛异常，全部包一层
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 存不了就算了 */ } }
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const input = $('#input');
  const pages = $('#pages');
  const canvasArea = $('#canvasArea');
  const measureHost = $('#measureHost');
  const pageInfo = $('#pageInfo');
  const charCount = $('#charCount');
  const sizeInfo = $('#sizeInfo');
  const btnExport = $('#btnExport');
  const btnExportAll = $('#btnExportAll');

  const contentHeight = () => RATIO_H[state.ratio] - PAD_TOP - PAD_BOTTOM;

  /* ---------------- 2. Markdown 解析 ----------------
     只实现卡片场景真正用得到的子集：标题、段落、强调、行内码、
     围栏代码、引用、有序/无序列表（支持一层嵌套）、分隔线、链接。
     刻意不支持原始 HTML —— 解析器永远不输出用户写的标签，
     innerHTML 注入这件事就从根上不存在了。
     -------------------------------------------------- */

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function inline(src) {
    const codes = [];
    // 行内代码先抽出来占位，避免里面的 * 和 [ ] 被后面的规则误伤
    let s = escapeHtml(src).replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
    return s;
  }

  const RE_FENCE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
  const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
  const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const RE_QUOTE = /^\s{0,3}>/;
  const RE_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

  const isBlockStart = (line) => {
    if (RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) ||
        RE_QUOTE.test(line) || RE_ITEM.test(line)) return true;
    return false;
  };

  // 把一组 {indent, ordered, text} 按缩进递归成嵌套列表
  function renderList(items, pos, indent) {
    const tag = items[pos].ordered ? 'ol' : 'ul';
    let html = '<' + tag + '>';
    while (pos < items.length && items[pos].indent >= indent) {
      if (items[pos].indent > indent) break;
      const item = items[pos];
      pos += 1;
      let nested = '';
      if (pos < items.length && items[pos].indent > indent) {
        const sub = renderList(items, pos, items[pos].indent);
        nested = sub.html;
        pos = sub.pos;
      }
      html += '<li>' + inline(item.text).replace(/\n/g, '<br>') + nested + '</li>';
    }
    return { html: html + '</' + tag + '>', pos: pos };
  }

  function readList(lines, start) {
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = RE_ITEM.exec(lines[i]);
      if (m) {
        items.push({
          indent: m[1].replace(/\t/g, '  ').length,
          ordered: /\d/.test(m[2]),
          text: m[3]
        });
        i += 1;
        continue;
      }
      // 缩进的续行，算作上一项的补充文字
      if (items.length && /^\s{2,}\S/.test(lines[i])) {
        items[items.length - 1].text += '\n' + lines[i].trim();
        i += 1;
        continue;
      }
      break;
    }
    return { html: renderList(items, 0, items[0].indent).html, next: i };
  }

  function mdToHtml(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) { i += 1; continue; }

      // 围栏代码
      const fence = RE_FENCE.exec(line);
      if (fence) {
        const mark = fence[1];
        const lang = fence[2];
        const buf = [];
        i += 1;
        while (i < lines.length && !new RegExp('^\\s{0,3}' + mark).test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1; // 跳过收尾的围栏
        out.push(
          '<pre' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') + '><code>' +
          escapeHtml(buf.join('\n')) + '</code></pre>'
        );
        continue;
      }

      // 标题
      const head = RE_HEADING.exec(line);
      if (head) {
        const lv = head[1].length;
        const text = head[2].replace(/\s+#+\s*$/, '');
        out.push('<h' + lv + '>' + inline(text) + '</h' + lv + '>');
        i += 1;
        continue;
      }

      // 分隔线
      if (RE_HR.test(line)) { out.push('<hr>'); i += 1; continue; }

      // 引用：剥掉 > 之后递归解析，这样引用里也能有列表和代码
      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>');
        continue;
      }

      // 列表
      if (RE_ITEM.test(line)) {
        const list = readList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      // 段落：一直到空行或下一个块的开头
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      // 卡片场景下，单个换行保留成换行比合并成空格更符合直觉
      out.push('<p>' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }

    return out.join('');
  }

  /* ---------------- 3. 测量与分页 ----------------
     为什么必须测量：标题、代码块、图片的行高完全不可预测，
     按字数切一定会在某一张图上切得很难看。
     做法是在一个隐藏的、宽度与卡片正文完全一致的容器里
     把每个块真实渲染一遍，拿到高度，再贪心装箱。
     ---------------------------------------------- */

  function measure(html) {
    // 测量容器本身是一个完整的 .card，所以字号、行高、内边距
    // 和真实卡片完全一致，量出来的高度才可信。
    measureHost.dataset.theme = state.theme;
    const body = measureHost.firstElementChild;
    body.innerHTML = html;

    const blocks = Array.from(body.children).map((el) => ({
      html: el.outerHTML,
      h: el.offsetHeight
    }));

    body.innerHTML = '';
    return blocks;
  }

  const isHeading = (block) => /^<h[1-6][\s>]/.test(block.html);

  function paginate(blocks, maxH) {
    const out = [[]];
    let used = 0;

    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      const page = out[out.length - 1];
      const add = page.length ? block.h + GAP : block.h;

      // 孤行控制：标题落在页底、正文却在下一页，是排版上最难看的一种断法。
      // 所以把「标题 + 紧随其后的那一块」当成一个整体来判断放不放得下。
      let need = add;
      if (isHeading(block) && i + 1 < blocks.length) {
        need = add + blocks[i + 1].h + GAP;
      }

      if (page.length && used + need > maxH) {
        out.push([block]);
        used = block.h;
      } else {
        page.push(block);
        used += add;
      }
    }
    return out;
  }

  /* ---------------- 4. 渲染 ---------------- */

  function cardHTML(blocks, index, total) {
    const h = RATIO_H[state.ratio];
    return (
      '<div class="page">' +
        '<div class="page-bar">' +
          '<span>第 ' + (index + 1) + ' / ' + total + ' 张</span>' +
          '<span class="dim">' + CARD_W + ' × ' + h + '</span>' +
          '<button class="mini" data-action="copy" data-page="' + index + '">复制</button>' +
          '<button class="mini" data-action="download" data-page="' + index + '">下载</button>' +
        '</div>' +
        '<article class="card" data-theme="' + state.theme + '" data-page="' + index + '" style="height:' + h + 'px">' +
          '<div class="card-body">' + blocks.map((b) => b.html).join('') + '</div>' +
          '<div class="card-foot">' +
            '<span class="brand">md2card</span>' +
            '<span class="pageno">' + (index + 1) + ' / ' + total + '</span>' +
          '</div>' +
        '</article>' +
      '</div>'
    );
  }

  function emptyHTML() {
    return (
      '<div class="empty">' +
        '<b>右边会是这张卡片</b>' +
        '在左边写点 Markdown，或者点一下「示例」看看效果。<br>' +
        '内容太长时会自动切成多张。' +
      '</div>'
    );
  }

  function render() {
    const raw = input.value;
    charCount.textContent = raw.trim().length + ' 字';
    sizeInfo.textContent = CARD_W + ' × ' + RATIO_H[state.ratio];

    if (!raw.trim()) {
      pages.innerHTML = emptyHTML();
      state.total = 0;
      pageInfo.textContent = '共 0 张';
      btnExport.disabled = true;
      btnExportAll.hidden = true;
      return;
    }

    let groups;
    try {
      const blocks = measure(mdToHtml(raw));
      groups = paginate(blocks, contentHeight());
    } catch (err) {
      console.error(err);
      toast('渲染出错：' + err.message);
      return;
    }

    state.total = groups.length;
    pages.innerHTML = groups.map((g, i) => cardHTML(g, i, groups.length)).join('');

    // 单块比一整页还高时（超长代码块），内容会被裁掉，给一条渐隐提示
    $$('.card', pages).forEach((card) => {
      const body = $('.card-body', card);
      if (body.scrollHeight > body.clientHeight + 2) card.classList.add('has-overflow');
    });

    pageInfo.textContent = '共 ' + groups.length + ' 张';
    btnExport.disabled = false;
    btnExportAll.hidden = groups.length < 2;
    fit();
  }

  // 卡片是固定 750px，窗口窄的时候整体缩放，而不是横向滚动
  function fit() {
    const avail = canvasArea.clientWidth - 32;
    const k = Math.min(1, avail / CARD_W);
    pages.style.zoom = k < 0.999 ? String(Math.max(k, 0.32)) : '';
  }

  /* ---------------- 5. 导出 ----------------
     不引 html-to-image / html2canvas。
     思路：把卡片 DOM 序列化进 <svg><foreignObject>，
     浏览器自己会按矢量渲染，再画到 2x 的 canvas 上。
     好处是导出的东西和预览一模一样，坏处是必须保证
     SVG 是合法 XML —— 这也是 <br> 要写成 <br/> 的原因。
     ---------------------------------------- */

  function buildSVG(cardEl) {
    const h = RATIO_H[state.ratio];
    const css = document.getElementById('card-style').textContent;
    const inner = cardEl.outerHTML
      .replace(/<br>/g, '<br/>')
      .replace(/<hr>/g, '<hr/>');

    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + CARD_W * SCALE + '" height="' + h * SCALE +
        '" viewBox="0 0 ' + CARD_W + ' ' + h + '">' +
        '<foreignObject x="0" y="0" width="' + CARD_W + '" height="' + h + '">' +
          '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + CARD_W + 'px;height:' + h + 'px;margin:0">' +
            '<style>' + css + '</style>' +
            inner +
          '</div>' +
        '</foreignObject>' +
      '</svg>'
    );
  }

  async function toPNG(cardEl) {
    const h = RATIO_H[state.ratio];
    const svg = buildSVG(cardEl);

    // 这里必须是 data: URL，不能用 URL.createObjectURL。
    // 原因：直接双击打开 index.html 时页面是 file:// 协议，
    // blob: 继承的是一个不透明源，把它画到 canvas 上会「污染」canvas，
    // 随后 toBlob 就会抛 "Tainted canvases may not be exported"。
    // data: URL 没有这个问题，而且体积极小（几十 KB 的纯文本）。
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('浏览器没能渲染这张卡片'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = CARD_W * SCALE;
    canvas.height = h * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成 PNG 失败'))), 'image/png');
    });
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function setBusy(busy, label) {
    state.busy = busy;
    btnExport.disabled = busy || state.total === 0;
    btnExportAll.disabled = busy;
    $('#exportLabel').textContent = busy ? (label || '导出中…') : '导出当前页';
  }

  async function exportPage(index) {
    if (state.busy) return;
    const card = pages.querySelector('.card[data-page="' + index + '"]');
    if (!card) return;

    setBusy(true);
    try {
      const blob = await toPNG(card);
      saveBlob(blob, 'md2card-' + (index + 1) + '.png');
      toast('已导出第 ' + (index + 1) + ' 张');
    } catch (err) {
      console.error(err);
      toast('导出失败：' + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPage(index) {
    if (state.busy) return;
    const card = pages.querySelector('.card[data-page="' + index + '"]');
    if (!card) return;

    setBusy(true, '处理中…');
    try {
      const blob = await toPNG(card);
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('no-clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('已复制图片，可以直接粘贴');
    } catch (err) {
      // Safari 之类不支持写图片的，静默降级成下载，别让它报错
      try {
        const blob = await toPNG(card);
        saveBlob(blob, 'md2card-' + (index + 1) + '.png');
        toast('这个浏览器不支持复制图片，已改为下载');
      } catch (e) {
        toast('导出失败：' + e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function exportAll() {
    if (state.busy || state.total < 2) return;
    setBusy(true);
    try {
      for (let i = 0; i < state.total; i += 1) {
        const card = pages.querySelector('.card[data-page="' + i + '"]');
        if (!card) continue;
        const blob = await toPNG(card);
        saveBlob(blob, 'md2card-' + (i + 1) + '.png');
        // 连续触发下载，浏览器会拦截；间隔一下更稳
        await new Promise((r) => setTimeout(r, 420));
      }
      toast('已导出全部 ' + state.total + ' 张');
    } catch (err) {
      console.error(err);
      toast('导出失败：' + err.message);
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 6. 交互 ---------------- */

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function debounce(fn, wait) {
    let t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  function setTheme(theme) {
    state.theme = theme;
    store.set(STORE.theme, theme);
    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
    render();
  }

  function setRatio(ratio) {
    state.ratio = ratio;
    store.set(STORE.ratio, ratio);
    $$('.segmented button').forEach((b) => b.classList.toggle('on', b.dataset.ratio === ratio));
    render();
  }

  const SAMPLE = [
    '# 把笔记变成一张图',
    '',
    '写作最难的部分从来不是写，而是**开始写**。',
    '',
    '## 三个可以立刻用上的习惯',
    '',
    '- 每天先写 100 字，不管好坏',
    '- 写完之后，删掉第一段',
    '- 把「我以为」换成「我查到」',
    '',
    '> 好的文字不是写出来的，是改出来的。',
    '',
    '## 一个最小的工作流',
    '',
    '```bash',
    'git commit -m "chore: 今天写了一点"',
    '```',
    '',
    '1. 打开编辑器',
    '2. 写满一屏',
    '3. 关掉，明天再来',
    '',
    '长文会自动拆成多张 —— 就像现在这样，往下滚一屏就能看到第二张。',
    '',
    '`md2card` 就是从这个习惯里长出来的。'
  ].join('\n');

  function saveDraft() {
    store.set(STORE.src, input.value);
  }

  const onInput = debounce(() => {
    render();
    saveDraft();
  }, 180);

  input.addEventListener('input', onInput);

  $$('.swatch').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });

  $$('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => setRatio(btn.dataset.ratio));
  });

  pages.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const index = Number(btn.dataset.page);
    if (btn.dataset.action === 'download') exportPage(index);
    if (btn.dataset.action === 'copy') copyPage(index);
  });

  btnExport.addEventListener('click', () => exportPage(0));
  btnExportAll.addEventListener('click', exportAll);

  $('#btnSample').addEventListener('click', () => {
    input.value = SAMPLE;
    render();
    saveDraft();
  });

  $('#btnClear').addEventListener('click', () => {
    input.value = '';
    render();
    saveDraft();
    input.focus();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      exportPage(0);
    }
  });

  window.addEventListener('resize', debounce(fit, 120));

  /* ---------------- 启动 ---------------- */

  (function boot() {
    const THEMES = ['paper', 'ink', 'mint', 'mono'];
    const theme = store.get(STORE.theme);
    const ratio = store.get(STORE.ratio);
    const draft = store.get(STORE.src);

    state.theme = THEMES.indexOf(theme) >= 0 ? theme : 'paper';
    state.ratio = ratio && RATIO_H[ratio] ? ratio : '3:4';

    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === state.theme)));
    $$('.segmented button').forEach((b) => b.classList.toggle('on', b.dataset.ratio === state.ratio));

    input.value = draft === null ? SAMPLE : draft;
    render();
  })();
})();
