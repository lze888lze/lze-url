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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

export async function handle(request, env) {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }

  const url = new URL(request.url);

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
    return jsonResponse(await getRecent(env, limit));
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
    SELECT id, time, ip, country, region, city, subdomain, path, method
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

async function getRecent(env, limit) {
  const result = await env.IP_LOG_DB.prepare(`
    SELECT
      id,
      time,
      ip,
      ip_version,
      country,
      region,
      city,
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
    ORDER BY id DESC
    LIMIT ?
  `).bind(limit).all();

  return result.results || [];
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
      <button onclick="loadAll()">刷新数据</button>
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

    async function loadAll() {
      document.getElementById('error').textContent = '';
      try {
        const [summary, recent, subdomain, path, country, daily] = await Promise.all([
          getJson('/api/summary'),
          getJson('/api/recent?limit=50'),
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
          const area = [row.country, row.region, row.city].filter(Boolean).join(' ');
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
      }
    }

    loadAll();
  </script>
</body>
</html>`;
}
