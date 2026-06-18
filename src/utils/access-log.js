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
        cf_colo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      now,
      ip,
      ipInfo?.版本 || '',
      data['国家'] || '',
      data['省份/州'] || '',
      data['城市'] || '',
      data['区县'] || '',
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
  const tencentResult = await lookupIpByTencent(env, ip);
  if (tencentResult) return tencentResult;

  const ip9Result = await lookupIpByIp9(ip);
  if (ip9Result) return ip9Result;

  return null;
}

async function lookupIpByTencent(env, ip) {
  if (!env.TENCENT_IP_KEY) {
    return null;
  }

  try {
    const apiUrl = `https://apis.map.qq.com/ws/location/v1/ip?key=${encodeURIComponent(env.TENCENT_IP_KEY)}&ip=${encodeURIComponent(ip)}&output=json`;
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      return null;
    }

    const data = await resp.json();

    // 0 正常；120 每秒上限；121 每日上限；382 IP无法定位。非 0 统一回退 IP9。
    if (data?.status !== 0 || !data?.result?.ad_info) {
      return null;
    }

    const ad = data.result.ad_info || {};
    const nation   = ad.nation   || '';
    const province = ad.province || '';
    const city     = ad.city     || '';
    const district = ad.district || '';

    // 直辖市去重：province 和 city 相同（如 "上海市"）时，
    // region 保留 province，city 置空，district 用 ad.district
    // 渲染效果：中国 上海市 浦东新区（跳过空的 city）
    // 普通省：中国 广东省 肇庆市 高要区
    let finalCity = city;
    let finalDistrict = district;
    if (province && city && province === city) {
      finalCity = '';
    }

    return {
      ip,
      '版本': ip.includes(':') ? 'IPv6' : 'IPv4',
      '归属地': [
        nation,
        province,
        finalCity,
        finalDistrict,
        ad.nation_code ? String(ad.nation_code) : ''
      ].join('|'),
      '数据': {
        '国家': nation,
        '省份/州': province,
        '城市': finalCity,
        '区县': finalDistrict,
        '运营商': '',
        '国家代码': ad.nation_code ? String(ad.nation_code) : ''
      },
      '消息': null
    };
  } catch (e) {
    console.error('腾讯 IP 查询失败:', e);
    return null;
  }
}

async function lookupIpByIp9(ip) {
  try {
    const apiUrl = `https://ip9.com.cn/get?ip=${encodeURIComponent(ip)}`;
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) {
      return null;
    }

    const data = await resp.json();
    if (data?.ret !== 200 || !data?.data) {
      return null;
    }

    const item = data.data || {};
    return {
      ip,
      '版本': ip.includes(':') ? 'IPv6' : 'IPv4',
      '归属地': [
        item.country || '',
        item.prov || '',
        item.city || '',
        '',
        item.isp || '',
        (item.country_code || '').toUpperCase()
      ].join('|'),
      '数据': {
        '国家': item.country || '',
        '省份/州': item.prov || '',
        '城市': item.city || '',
        '区县': '',
        '运营商': item.isp || '',
        '国家代码': (item.country_code || '').toUpperCase()
      },
      '消息': null
    };
  } catch (e) {
    console.error('IP9 查询失败:', e);
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
