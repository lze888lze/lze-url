/**
 * 访问日志工具
 *
 * 用于在 Worker 后台异步查询访问者 IP 归属地，并写入 D1。
 * 这里的逻辑通过 ctx.waitUntil 调用，不阻塞用户请求。
 */

export async function recordAccessToD1(request, env, sub) {
  if (!env.IP_LOG_DB) {
    return;
  }

  const url = new URL(request.url);
  if (shouldSkipAccessLog(url)) {
    return;
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';
  const cf = request.cf || {};
  const now = getBeijingTime();

  let ipInfo = null;
  if (ip) {
    ipInfo = await lookupIp(env, ip);
  }

  const data = ipInfo?.数据 || {};

  try {
    await env.IP_LOG_DB.prepare(`
      INSERT INTO access_logs (
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
        cf_colo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      now,
      ip,
      ipInfo?.版本 || '',
      data['国家'] || '',
      data['省份/州'] || '',
      data['城市'] || '',
      data['运营商'] || '',
      data['国家代码'] || '',
      ipInfo?.归属地 || '',
      url.hostname,
      sub,
      url.pathname,
      url.search || '',
      request.method,
      ua.slice(0, 500),
      referer.slice(0, 500),
      cf.country || '',
      cf.region || '',
      cf.city || '',
      cf.colo || ''
    ).run();
  } catch (e) {
    console.error('D1 访问记录写入失败:', e);
  }
}

function shouldSkipAccessLog(url) {
  const path = url.pathname.toLowerCase();

  // 浏览器和爬虫经常自动请求，通常不算业务访问
  if (path === '/favicon.ico' || path === '/robots.txt' || path === '/sitemap.xml') {
    return true;
  }

  // 过滤常见公网扫描路径，避免 D1 被无意义数据刷屏
  const blockedPrefixes = [
    '/wp-',
    '/wp/',
    '/wp-admin',
    '/wp-content',
    '/wp-includes',
    '/wp-json',
    '/xmlrpc.php',
    '/.env',
    '/.git',
    '/phpmyadmin',
  ];

  return blockedPrefixes.some(prefix => path.startsWith(prefix));
}

async function lookupIp(env, ip) {
  if (!env.IP_LOOKUP_API) {
    return null;
  }

  try {
    const apiUrl = `${env.IP_LOOKUP_API}?ip=${encodeURIComponent(ip)}`;
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      return null;
    }

    const data = await resp.json();
    if (data?.消息) {
      return null;
    }

    return data;
  } catch (e) {
    console.error('IP 查询失败:', e);
    return null;
  }
}

function getBeijingTime() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}
