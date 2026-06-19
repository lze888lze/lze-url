/**
 * logs 模块 - D1 访问日志看板
 *
 * 子域名:
 *   logs.lze.cc.cd -> 访问日志看板
 *
 * 数据源:
 *   D1 绑定 IP_LOG_DB，表 access_logs
 */

export const subdomains = {
  'logs': 'logs'
};

export const folder = 'logs';

const PAGE_SIZE = 50;
const AUTH_COOKIE = 'logs_auth';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store'
    }
  });
}

function redirectResponse(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': location,
      ...headers
    }
  });
}

export async function handle(request, env, indexFile, sub, ctx) {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }

  const url = new URL(request.url);

  if (!getPassword(env)) {
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: '服务端未配置 LOGS_PASSWORD' }, 500);
    }

    return htmlResponse(renderConfigErrorPage());
  }

  if (url.pathname === '/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  if (url.pathname === '/logout') {
    return redirectResponse('/', {
      'Set-Cookie': `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    });
  }

  const authed = await isAuthed(request, env);
  if (!authed) {
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: '未登录' }, 401);
    }

    return htmlResponse(renderLoginPage(url.searchParams.get('error') === '1'));
  }

  if (!env.IP_LOG_DB) {
    return jsonResponse({ error: 'D1 未绑定：IP_LOG_DB' }, 500);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return htmlResponse(renderPage());
  }

  if (url.pathname === '/api/summary') {
    return jsonResponse(await getSummary(env));
  }

  if (url.pathname === '/api/recent') {
    const limit = clampNumber(url.searchParams.get('limit'), 1, 200, PAGE_SIZE);
    return jsonResponse(await getRecent(env, url.searchParams, limit));
  }

  if (url.pathname === '/api/clear' && request.method === 'POST') {
    return jsonResponse(await clearLogs(env));
  }

  if (url.pathname === '/api/stats/subdomain') {
    return jsonResponse(await getGroupedStats(env, 'subdomain'));
  }

  if (url.pathname === '/api/stats/path') {
    return jsonResponse(await getGroupedStats(env, 'path'));
  }

  if (url.pathname === '/api/stats/country') {
    return jsonResponse(await getCountryStats(env));
  }

  if (url.pathname === '/api/stats/daily') {
    return jsonResponse(await getDailyStats(env));
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}

async function handleLogin(request, env) {
  const expected = getPassword(env);
  if (!expected) {
    return htmlResponse(renderConfigErrorPage());
  }

  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (password !== expected) {
    return redirectResponse('/?error=1');
  }

  const token = await createAuthToken(expected);
  return redirectResponse('/', {
    'Set-Cookie': `${AUTH_COOKIE}=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`
  });
}

async function isAuthed(request, env) {
  const password = getPassword(env);
  if (!password) {
    return false;
  }

  const cookie = request.headers.get('cookie') || '';
  const token = getCookie(cookie, AUTH_COOKIE);
  if (!token) {
    return false;
  }

  return token === await createAuthToken(password);
}

function getPassword(env) {
  return env.LOGS_PASSWORD || '';
}

function getCookie(cookie, name) {
  return cookie
    .split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(`${name}=`))
    ?.slice(name.length + 1) || '';
}

async function createAuthToken(password) {
  const data = new TextEncoder().encode(`logs:${password}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function getSummary(env) {
  const total = await firstValue(env, 'SELECT COUNT(*) AS value FROM access_logs');
  const today = await firstValue(
    env,
    "SELECT COUNT(*) AS value FROM access_logs WHERE date(created_at, 'unixepoch', '+8 hours') = date('now', '+8 hours')"
  );
  const uniqueIp = await firstValue(env, 'SELECT COUNT(DISTINCT ip) AS value FROM access_logs');
  const last = await env.IP_LOG_DB.prepare(`
    SELECT id, time, ip, country, region, city, district, subdomain, path, method
    FROM access_logs
    ORDER BY id DESC
    LIMIT 1
  `).first();

  return {
    total: total || 0,
    today: today || 0,
    uniqueIp: uniqueIp || 0,
    last: last || null
  };
}

async function firstValue(env, sql) {
  const row = await env.IP_LOG_DB.prepare(sql).first();
  return row?.value ?? 0;
}

async function getRecent(env, searchParams, limit) {
  const filters = buildRecentFilters(searchParams);
  const result = await env.IP_LOG_DB.prepare(`
    SELECT
      id,
      time,
      ip,
      ip_version,
      country,
      region,
      city,
      district,
      isp,
      country_code,
      raw_region,
      host,
      subdomain,
      path,
      query,
      method,
      user_agent,
      referer,
      cf_country,
      cf_region,
      cf_city,
      cf_colo,
      created_at
    FROM access_logs
    ${filters.where}
    ORDER BY id DESC
    LIMIT ?
  `).bind(...filters.values, limit).all();

  return result.results || [];
}

function buildRecentFilters(searchParams) {
  const where = [];
  const values = [];

  const q = (searchParams.get('q') || '').trim();
  const subdomain = (searchParams.get('subdomain') || '').trim();
  const method = (searchParams.get('method') || '').trim().toUpperCase();

  if (q) {
    const like = `%${q}%`;
    where.push(`(
      ip LIKE ?
      OR country LIKE ?
      OR region LIKE ?
      OR city LIKE ?
      OR district LIKE ?
      OR isp LIKE ?
      OR path LIKE ?
      OR query LIKE ?
      OR user_agent LIKE ?
      OR raw_region LIKE ?
    )`);
    values.push(like, like, like, like, like, like, like, like, like, like);
  }

  if (subdomain) {
    where.push('subdomain = ?');
    values.push(subdomain);
  }

  if (method) {
    where.push('method = ?');
    values.push(method);
  }

  return {
    where: where.length ? `WHERE ${where.join(' AND ')}` : '',
    values
  };
}

async function clearLogs(env) {
  await env.IP_LOG_DB.prepare('DELETE FROM access_logs').run();
  await env.IP_LOG_DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'access_logs'").run();
  return { ok: true };
}

async function getGroupedStats(env, field) {
  const allow = new Set(['subdomain', 'path']);
  if (!allow.has(field)) {
    return [];
  }

  const result = await env.IP_LOG_DB.prepare(`
    SELECT ${field} AS name, COUNT(*) AS count
    FROM access_logs
    GROUP BY ${field}
    ORDER BY count DESC
    LIMIT 20
  `).all();

  return result.results || [];
}

async function getCountryStats(env) {
  const result = await env.IP_LOG_DB.prepare(`
    SELECT
      COALESCE(NULLIF(country, ''), '未知') AS country,
      COALESCE(NULLIF(region, ''), '') AS region,
      COUNT(*) AS count
    FROM access_logs
    GROUP BY country, region
    ORDER BY count DESC
    LIMIT 30
  `).all();

  return result.results || [];
}

async function getDailyStats(env) {
  const result = await env.IP_LOG_DB.prepare(`
    SELECT
      date(created_at, 'unixepoch', '+8 hours') AS day,
      COUNT(*) AS count
    FROM access_logs
    GROUP BY day
    ORDER BY day DESC
    LIMIT 14
  `).all();

  return (result.results || []).reverse();
}

function renderLoginPage(hasError) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>访问日志看板登录</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f6fb;
      --card: #ffffff;
      --text: #162033;
      --muted: #667085;
      --border: #d9deea;
      --accent: #2563eb;
      --danger: #c2410c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1420;
        --card: #171d2a;
        --text: #e8edf7;
        --muted: #aab5c8;
        --border: #2d3748;
        --accent: #7aa2ff;
        --danger: #fb923c;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .card {
      width: min(420px, calc(100% - 32px));
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 20px; color: var(--muted); }
    label {
      display: block;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 16px;
      color: var(--text);
      background: transparent;
      outline: none;
    }
    input:focus { border-color: var(--accent); }
    button {
      width: 100%;
      border: 0;
      border-radius: 12px;
      background: var(--accent);
      color: white;
      padding: 12px 16px;
      font-size: 15px;
      cursor: pointer;
      margin-top: 16px;
    }
    .error {
      color: var(--danger);
      margin-top: 12px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>访问日志看板</h1>
    <p>请输入密码后查看 D1 访问日志数据。</p>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit">进入看板</button>
    ${hasError ? '<div class="error">密码错误，请重新输入。</div>' : ''}
  </form>
</body>
</html>`;
}

function renderConfigErrorPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>日志看板配置缺失</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f6fb;
      --card: #ffffff;
      --text: #162033;
      --muted: #667085;
      --border: #d9deea;
      --danger: #c2410c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1420;
        --card: #171d2a;
        --text: #e8edf7;
        --muted: #aab5c8;
        --border: #2d3748;
        --danger: #fb923c;
      }
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .card {
      width: min(520px, calc(100% - 32px));
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
    }
    h1 { margin: 0 0 10px; font-size: 24px; color: var(--danger); }
    p { margin: 8px 0; color: var(--muted); line-height: 1.7; }
    code {
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(127, 127, 127, 0.14);
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>缺少密码配置</h1>
    <p>请在 Cloudflare Worker 的变量和密钥中添加密钥变量：</p>
    <p><code>LOGS_PASSWORD</code></p>
    <p>保存并部署后，再访问日志看板。</p>
  </div>
</body>
</html>`;
}

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>访问日志看板</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f6fb;
      --card: #ffffff;
      --text: #162033;
      --muted: #667085;
      --border: #d9deea;
      --soft: #eef2f8;
      --accent: #2563eb;
      --danger: #c2410c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1420;
        --card: #171d2a;
        --text: #e8edf7;
        --muted: #aab5c8;
        --border: #2d3748;
        --soft: #20283a;
        --accent: #7aa2ff;
        --danger: #fb923c;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main {
      width: min(1280px, calc(100% - 32px));
      margin: 28px auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
    }
    h1 { margin: 0 0 6px; font-size: 28px; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { margin: 0; color: var(--muted); }
    button {
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: white;
      padding: 10px 16px;
      font-size: 14px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--soft);
      color: var(--text);
      border: 1px solid var(--border);
    }
    button.danger {
      background: var(--danger);
      color: white;
    }
    button {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr 150px 120px auto auto auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 14px;
    }
    .field label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: transparent;
      color: var(--text);
      outline: none;
    }
    input:focus, select:focus { border-color: var(--accent); }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
    }
    .metric {
      font-size: 30px;
      font-weight: 700;
      margin-top: 8px;
    }
    .charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 9px 8px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th { color: var(--muted); font-weight: 600; }
    td.path, td.ua {
      white-space: normal;
      word-break: break-all;
      max-width: 280px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 120px 1fr 52px;
      align-items: center;
      gap: 10px;
      margin: 8px 0;
      font-size: 13px;
    }
    .bar-bg {
      background: var(--soft);
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
    }
    .bar {
      height: 100%;
      background: var(--accent);
      border-radius: 999px;
    }
    .muted { color: var(--muted); }
    .error { color: var(--danger); margin-top: 10px; }
    @media (max-width: 900px) {
      header { display: block; }
      button { margin-top: 14px; }
      .filters { grid-template-columns: 1fr; }
      .grid, .charts { grid-template-columns: 1fr; }
      table { font-size: 12px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>访问日志看板</h1>
        <p>查看 D1 中记录的业务访问数据，数据来自 access_logs 表。</p>
      </div>
      <div>
        <button id="refreshBtn" onclick="loadAll()">
          <span id="refreshText">刷新数据</span>
          <span id="refreshSpinner" class="spinner" style="display:none"></span>
        </button>
        <a href="/logout" style="margin-left:10px;color:var(--muted);text-decoration:none">退出</a>
      </div>
    </header>

    <section class="grid">
      <div class="card"><p>总访问量</p><div class="metric" id="total">--</div></div>
      <div class="card"><p>今日访问</p><div class="metric" id="today">--</div></div>
      <div class="card"><p>独立 IP</p><div class="metric" id="uniqueIp">--</div></div>
      <div class="card"><p>最后访问</p><div class="metric" id="lastId">--</div></div>
    </section>

    <section class="charts">
      <div class="card"><h2>子域名统计</h2><div id="subdomainStats"></div></div>
      <div class="card"><h2>路径统计</h2><div id="pathStats"></div></div>
      <div class="card"><h2>地区统计</h2><div id="countryStats"></div></div>
      <div class="card"><h2>近 14 天访问</h2><div id="dailyStats"></div></div>
    </section>

    <section class="card">
      <h2>最近访问</h2>
      <div class="filters">
        <div class="field">
          <label for="q">搜索</label>
          <input id="q" placeholder="IP、国家、地区、路径、UA">
        </div>
        <div class="field">
          <label for="subdomain">子域名</label>
          <select id="subdomain">
            <option value="">全部</option>
            <option value="hf-api">hf-api</option>
            <option value="docs">docs</option>
            <option value="peilv">peilv</option>
            <option value="peilv-admin">peilv-admin</option>
            <option value="logs">logs</option>
          </select>
        </div>
        <div class="field">
          <label for="method">方法</label>
          <select id="method">
            <option value="">全部</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="OPTIONS">OPTIONS</option>
          </select>
        </div>
        <button onclick="loadAll()">应用筛选</button>
        <button class="secondary" onclick="resetFilters()">重置</button>
        <button class="danger" onclick="clearAllLogs()">清空日志</button>
      </div>
      <div style="overflow:auto">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>时间</th>
              <th>IP</th>
              <th>地区</th>
              <th>子域名</th>
              <th>方法</th>
              <th>路径</th>
              <th>UA</th>
            </tr>
          </thead>
          <tbody id="recentRows">
            <tr><td colspan="8" class="muted">加载中...</td></tr>
          </tbody>
        </table>
      </div>
      <div class="error" id="error"></div>
    </section>
  </main>

  <script>
    async function getJson(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    function text(value) {
      return value === null || value === undefined || value === '' ? '-' : String(value);
    }

    function renderBars(el, rows, labelFn) {
      const max = Math.max(1, ...rows.map(r => r.count || 0));
      el.innerHTML = rows.length ? rows.map(row => {
        const label = labelFn(row);
        const width = Math.max(4, Math.round((row.count || 0) / max * 100));
        return '<div class="bar-row"><div title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div><div class="bar-bg"><div class="bar" style="width:' + width + '%"></div></div><div>' + row.count + '</div></div>';
      }).join('') : '<p class="muted">暂无数据</p>';
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
    }

    function getFilters() {
      const params = new URLSearchParams();
      params.set('limit', '50');

      const q = document.getElementById('q').value.trim();
      const subdomain = document.getElementById('subdomain').value;
      const method = document.getElementById('method').value;

      if (q) params.set('q', q);
      if (subdomain) params.set('subdomain', subdomain);
      if (method) params.set('method', method);

      return params.toString();
    }

    function resetFilters() {
      document.getElementById('q').value = '';
      document.getElementById('subdomain').value = '';
      document.getElementById('method').value = '';
      loadAll();
    }

    async function clearAllLogs() {
      const first = confirm('确定要清空全部访问日志吗？这个操作不能撤销。');
      if (!first) return;

      const second = prompt('请输入 DELETE 确认清空全部日志');
      if (second !== 'DELETE') {
        alert('已取消清空。');
        return;
      }

      try {
        const res = await fetch('/api/clear', { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        alert('日志已清空。');
        loadAll();
      } catch (e) {
        document.getElementById('error').textContent = '清空失败：' + e.message;
      }
    }

    async function loadAll() {
      const textEl = document.getElementById('refreshText');
      const spinnerEl = document.getElementById('refreshSpinner');
      const btn = document.getElementById('refreshBtn');
      btn.disabled = true;
      textEl.style.display = 'none';
      spinnerEl.style.display = 'inline-block';
      document.getElementById('error').textContent = '';
      try {
        const [summary, recent, subdomain, path, country, daily] = await Promise.all([
          getJson('/api/summary'),
          getJson('/api/recent?' + getFilters()),
          getJson('/api/stats/subdomain'),
          getJson('/api/stats/path'),
          getJson('/api/stats/country'),
          getJson('/api/stats/daily')
        ]);

        document.getElementById('total').textContent = summary.total;
        document.getElementById('today').textContent = summary.today;
        document.getElementById('uniqueIp').textContent = summary.uniqueIp;
        document.getElementById('lastId').textContent = summary.last ? '#' + summary.last.id : '--';

        renderBars(document.getElementById('subdomainStats'), subdomain, r => r.name || '未知');
        renderBars(document.getElementById('pathStats'), path, r => r.name || '/');
        renderBars(document.getElementById('countryStats'), country, r => [r.country, r.region].filter(Boolean).join(' ') || '未知');
        renderBars(document.getElementById('dailyStats'), daily, r => r.day || '未知');

        const tbody = document.getElementById('recentRows');
        tbody.innerHTML = recent.length ? recent.map(row => {
          const area = [row.country, row.region, row.city, row.district].filter(Boolean).join(' ');
          const fullPath = (row.path || '') + (row.query || '');
          return '<tr>' +
            '<td>' + row.id + '</td>' +
            '<td>' + escapeHtml(text(row.time)) + '</td>' +
            '<td>' + escapeHtml(text(row.ip)) + '</td>' +
            '<td>' + escapeHtml(text(area)) + '</td>' +
            '<td>' + escapeHtml(text(row.subdomain)) + '</td>' +
            '<td>' + escapeHtml(text(row.method)) + '</td>' +
            '<td class="path">' + escapeHtml(text(fullPath)) + '</td>' +
            '<td class="ua">' + escapeHtml(text(row.user_agent)) + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="8" class="muted">暂无数据</td></tr>';
      } catch (e) {
        document.getElementById('error').textContent = '加载失败：' + e.message;
      } finally {
        textEl.style.display = 'inline';
        spinnerEl.style.display = 'none';
        btn.disabled = false;
      }
    }

    loadAll();
  </script>
</body>
</html>`;
}
