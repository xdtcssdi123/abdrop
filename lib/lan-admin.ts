/**
 * 局域网管理页(单文件 HTML,由 GET / 返回)。
 *
 * 纯原生 JS + fetch 调同源 /api/*,零构建依赖。
 * 功能:健康状态、卡片浏览/新增/删除、合集管理、复习范围、AI 配置(apiKey 打码)、打卡、全屏。
 */
export const LAN_ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ABDrop · 局域网管理</title>
<style>
  :root {
    --bg: #eef1f4;
    --card: #ffffff;
    --ink: #1b2430;
    --ink-2: #5a6b7d;
    --ink-3: #93a1b0;
    --line: rgba(27,36,48,.10);
    --accent: #2f6fed;
    --danger: #d64545;
    --ok: #1f9d63;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--ink);
    font-size: 15px;
    line-height: 1.5;
  }
  header {
    padding: 18px 20px 10px;
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  header h1 { font-size: 20px; margin: 0; }
  header .ver { color: var(--ink-3); font-size: 13px; }
  header .ok { color: var(--ok); font-size: 13px; margin-left: auto; }
  main { padding: 8px 20px 40px; max-width: 720px; margin: 0 auto; }
  .panel {
    background: var(--card);
    border-radius: var(--radius);
    border: 1px solid var(--line);
    padding: 16px 18px;
    margin: 12px 0;
    box-shadow: 0 1px 4px rgba(15,23,42,.05);
  }
  .panel h2 { font-size: 15px; margin: 0 0 12px; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  input[type=text], input[type=url], input[type=number], select, textarea {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #fbfcfd;
    font-size: 14px;
    font-family: inherit;
    color: var(--ink);
  }
  textarea { min-height: 64px; resize: vertical; }
  label.lbl { font-size: 13px; color: var(--ink-2); width: 88px; flex: 0 0 auto; }
  .sw { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; margin: 8px 8px 8px 0; }
  .sw input { width: 18px; height: 18px; }
  button {
    padding: 8px 14px;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    background: var(--accent);
    color: #fff;
  }
  button.ghost { background: #e8edf3; color: var(--ink); }
  button.danger { background: #fdecec; color: var(--danger); }
  button:disabled { opacity: .5; cursor: default; }
  ul.cards { list-style: none; margin: 0; padding: 0; }
  ul.cards li {
    padding: 12px 2px;
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  ul.cards li:last-child { border-bottom: none; }
  .c-front { font-weight: 600; }
  .c-back { color: var(--ink-2); font-size: 13px; margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
  .c-meta { color: var(--ink-3); font-size: 12px; margin-top: 4px; }
  .tag {
    display: inline-block;
    background: #eef2f8;
    color: var(--ink-2);
    border-radius: 6px;
    padding: 1px 7px;
    font-size: 12px;
    margin-right: 4px;
  }
  .img-badge { color: var(--accent); font-size: 12px; }
  .c-del { margin-left: auto; flex: 0 0 auto; }
  .empty { color: var(--ink-3); text-align: center; padding: 18px 0; }
  .hint { font-size: 12px; color: var(--ink-3); margin: 6px 0 0; }
  .masked { font-family: ui-monospace, monospace; letter-spacing: 1px; }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    background: rgba(27,36,48,.92);
    color: #fff;
    padding: 10px 18px;
    border-radius: 12px;
    font-size: 14px;
    opacity: 0;
    transition: opacity .25s;
    pointer-events: none;
    z-index: 10;
    max-width: 86vw;
  }
  .toast.show { opacity: 1; }
  .cols { display: flex; gap: 12px; flex-wrap: wrap; }
  .cols select { flex: 1; }
</style>
</head>
<body>
<header>
  <h1>ABDrop</h1>
  <span class="ver" id="ver">—</span>
  <span class="ok" id="conn">…</span>
</header>

<main>
  <div class="panel">
    <h2>➕ 新增卡片</h2>
    <div class="row"><label class="lbl">正面</label><input id="nf" type="text" placeholder="问题 / 知识点标题"></div>
    <div class="row"><label class="lbl">背面</label><textarea id="nb" placeholder="答案 / 解释(可选)"></textarea></div>
    <div class="row">
      <label class="lbl">合集</label>
      <select id="ncol"></select>
    </div>
    <div class="row"><label class="lbl">标签</label><input id="ntag" type="text" placeholder="用逗号分隔,如: 数学,公式"></div>
    <div class="row">
      <button onclick="addCard()">保存卡片</button>
      <span class="hint">保存后立即入库,手机端可同步复习。</span>
    </div>
  </div>

  <div class="panel">
    <h2>🗂️ 合集</h2>
    <div class="row">
      <select id="colFilter" onchange="loadCards()"></select>
      <input id="newCol" type="text" placeholder="新合集名称">
      <button class="ghost" onclick="addCollection()">新建</button>
    </div>
    <div class="row">
      <label class="lbl" style="width:auto">复习范围</label>
      <select id="scopeSel" onchange="setScope()"></select>
      <span class="hint">首页刷卡按此范围。</span>
    </div>
  </div>

  <div class="panel">
    <h2>📇 卡片列表 <span class="ver" id="count"></span></h2>
    <ul class="cards" id="cardList"></ul>
  </div>

  <div class="panel">
    <h2>⚙️ 配置</h2>
    <div class="sw"><input id="aiEnabled" type="checkbox"><span>启用 AI 归纳</span></div>
    <div class="row"><label class="lbl">接口地址</label><input id="aiBase" type="url" placeholder="https://api.openai.com/v1"></div>
    <div class="row"><label class="lbl">模型</label><input id="aiModel" type="text" placeholder="gpt-4o-mini"></div>
    <div class="row"><label class="lbl">API Key</label><input id="aiKey" type="text" class="masked" placeholder="留空保持不变"></div>
    <div class="sw"><input id="aiVision" type="checkbox"><span>识别图片</span></div>
    <div class="sw"><input id="ckEnabled" type="checkbox"><span>每日打卡提醒</span></div>
    <div class="row">
      <label class="lbl">开始</label><input id="ckStart" type="number" min="0" max="23" step="1">
      <label class="lbl">结束</label><input id="ckEnd" type="number" min="0" max="23" step="1">
    </div>
    <div class="sw"><input id="fsOn" type="checkbox"><span>全屏沉浸(隐藏状态栏)</span></div>
    <div class="row"><button onclick="saveConfig()">保存配置</button></div>
  </div>
</main>
<div class="toast" id="toast"></div>

<script>
var api = function (method, path, body) {
  return fetch(path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
};
var toastTimer = null;
function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
}
function el(id) { return document.getElementById(id); }
function fillSel(sel, items, selected) {
  sel.innerHTML = '';
  items.forEach(function (it) {
    var o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.name;
    if (selected === it.id) o.selected = true;
    sel.appendChild(o);
  });
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 初始化 ─────────────────────────────────────────────
Promise.all([api('GET', '/api/health'), api('GET', '/api/collections')]).then(function (r) {
  var health = r[0], cols = r[1];
  el('ver').textContent = 'v' + (health.version || '?');
  el('conn').textContent = health.ok ? '已连接' : '异常';
  var colls = cols.collections || [];
  fillSel(el('ncol'), colls, cols.activeCollectionId);
  fillSel(el('colFilter'), colls, null);
  fillSel(el('scopeSel'), colls, cols.activeCollectionId);
  loadCards();
  loadConfig();
});

function loadCards() {
  var colId = el('colFilter').value;
  var q = colId ? '?collectionId=' + encodeURIComponent(colId) : '';
  api('GET', '/api/cards' + q).then(function (d) {
    var list = el('cardList');
    var cards = d.cards || [];
    el('count').textContent = cards.length + ' 张';
    if (!cards.length) {
      list.innerHTML = '<li class="empty">这个合集还没有卡片</li>';
      return;
    }
    list.innerHTML = cards.map(function (c) {
      var tags = (c.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
      var img = c.image ? '<span class="img-badge">🖼 有图</span> ' : '';
      return '<li>' +
        '<div>' +
          '<div class="c-front">' + esc(c.front) + '</div>' +
          (c.back ? '<div class="c-back">' + esc(c.back) + '</div>' : '') +
          '<div class="c-meta">' + img + esc(c.collectionName) + ' ' + tags + '</div>' +
        '</div>' +
        '<button class="danger c-del" onclick="delCard(\'' + c.id + '\')">删除</button>' +
      '</li>';
    }).join('');
  });
}
function addCard() {
  var front = el('nf').value.trim();
  if (!front) { toast('正面内容不能为空'); return; }
  api('POST', '/api/cards', {
    front: front,
    back: el('nb').value.trim(),
    collectionId: el('ncol').value,
    tags: el('ntag').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
  }).then(function (d) {
    if (d.ok) {
      toast('卡片已保存');
      el('nf').value = ''; el('nb').value = ''; el('ntag').value = '';
      loadCards(); refreshMeta();
    } else { toast(d.error || '保存失败'); }
  });
}
function delCard(id) {
  if (!window.confirm('删除这张卡片?')) return;
  api('DELETE', '/api/cards/' + encodeURIComponent(id)).then(function () {
    toast('已删除');
    loadCards(); refreshMeta();
  });
}
function addCollection() {
  var name = el('newCol').value.trim();
  if (!name) { toast('请输入合集名称'); return; }
  api('POST', '/api/collections', { name: name }).then(function (d) {
    if (d.ok) {
      toast('合集已创建');
      el('newCol').value = '';
      return api('GET', '/api/collections').then(function (cols) {
        var colls = cols.collections || [];
        fillSel(el('ncol'), colls, null);
        fillSel(el('colFilter'), colls, null);
        fillSel(el('scopeSel'), colls, cols.activeCollectionId);
      });
    } else { toast(d.error || '创建失败'); }
  });
}
function setScope() {
  api('POST', '/api/scope', { collectionId: el('scopeSel').value }).then(function (d) {
    toast(d.ok ? '复习范围已切换' : (d.error || '切换失败'));
  });
}
function refreshMeta() {
  api('GET', '/api/health').then(function (h) {
    el('ver').textContent = 'v' + (h.version || '?');
  });
}
function loadConfig() {
  api('GET', '/api/config').then(function (d) {
    var ai = d.ai || {}, ck = d.checkin || {}, fs = d.fullscreen;
    el('aiEnabled').checked = !!ai.enabled;
    el('aiBase').value = ai.baseUrl || '';
    el('aiModel').value = ai.model || '';
    el('aiKey').value = ai.apiKeyMasked || '';
    el('aiVision').checked = !!ai.vision;
    el('ckEnabled').checked = !!ck.enabled;
    el('ckStart').value = Math.floor((ck.startMinute == null ? 540 : ck.startMinute) / 60);
    el('ckEnd').value = Math.floor((ck.endMinute == null ? 1320 : ck.endMinute) / 60);
    el('fsOn').checked = !!fs;
  });
}
function saveConfig() {
  var payload = {
    ai: {
      enabled: el('aiEnabled').checked,
      baseUrl: el('aiBase').value.trim(),
      model: el('aiModel').value.trim(),
      apiKey: el('aiKey').value.trim(),
      vision: el('aiVision').checked,
    },
    checkin: {
      enabled: el('ckEnabled').checked,
      startMinute: (parseInt(el('ckStart').value, 10) || 0) * 60,
      endMinute: (parseInt(el('ckEnd').value, 10) || 23) * 60,
    },
    fullscreen: el('fsOn').checked,
  };
  api('POST', '/api/config', payload).then(function (d) {
    toast(d.ok ? '配置已保存' : (d.error || '保存失败'));
  });
}
</script>
</body>
</html>`
