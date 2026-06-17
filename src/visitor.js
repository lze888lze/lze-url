/**
 * 访问统计模块
 *
 * R2 存储路径:
 *   data/peilv/visitors.json
 *   data/peilv-admin/visitors.json
 */

const MAX_RECORDS = 5000;

// xdb 缓存
let xdbV4Cache = null;
let xdbV6Cache = null;
let xdbLoaded = false;

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
}

async function loadXdbOnce(env) {
  if (xdbLoaded) return;
  xdbLoaded = true;

  try {
    const v4 = await env.PEILV_BUCKET.get('ipv4-ipv6/ip2region_v4.xdb');
    if (v4) xdbV4Cache = new Uint8Array(await v4.arrayBuffer());
  } catch (e) { /* ignore */ }

  try {
    const v6 = await env.PEILV_BUCKET.get('ipv4-ipv6/ip2region_v6.xdb');
    if (v6) xdbV6Cache = new Uint8Array(await v6.arrayBuffer());
  } catch (e) { /* ignore */ }
}

function readInt32(buf, offset) {
  return (buf[offset] & 0xFF) |
    ((buf[offset + 1] & 0xFF) << 8) |
    ((buf[offset + 2] & 0xFF) << 16) |
    ((buf[offset + 3] & 0xFF) << 24);
}

function ipToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const n = parseInt(parts[i], 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) + n;
  }
  return num >>> 0;
}

function searchXdb(xdb, ip) {
  if (!xdb) return null;
  try {
    const indexLen = readInt32(xdb, 0);
    const indexPtr = readInt32(xdb, 4);
    if (!indexLen || !indexPtr) return null;

    const ipInt = ipToLong(ip);
    if (ipInt === null) return null;

    let low = 0;
    let high = (indexLen - 8) / 12;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const pos = indexPtr + mid * 12;
      const startIp = readInt32(xdb, pos);
      const endIp = readInt32(xdb, pos + 4);
      const dataPtr = readInt32(xdb, pos + 8) & 0x00FFFFFF;
      const dataLen = xdb[pos + 11];

      if (ipInt < startIp) {
        high = mid - 1;
      } else if (ipInt > endIp) {
        low = mid + 1;
      } else {
        return new TextDecoder().decode(xdb.slice(dataPtr, dataPtr + dataLen));
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function getLocation(request, env) {
  const ip = getClientIP(request);
  const cf = request.cf || {};

  await loadXdbOnce(env);

  const region = ip.includes(':') ? null : searchXdb(xdbV4Cache, ip);

  if (region) {
    const p = region.split('|');
    return {
      country: p[0] || cf.country || '',
      region: p[2] || cf.region || '',
      city: p[3] || cf.city || '',
      isp: p[4] || '',
      source: 'ip2region'
    };
  }

  return {
    country: cf.country || '',
    region: cf.region || '',
    city: cf.city || '',
    isp: '',
    source: 'cf'
  };
}

async function loadVisitors(env, sub) {
  try {
    const obj = await env.PEILV_BUCKET.get(`data/${sub}/visitors.json`);
    if (!obj) return [];
    return JSON.parse(await obj.text());
  } catch (e) {
    return [];
  }
}

async function saveVisitors(env, sub, records) {
  await env.PEILV_BUCKET.put(
    `data/${sub}/visitors.json`,
    JSON.stringify(records, null, 2)
  );
}

/**
 * 记录访问 — 供模块调用，内部完成所有异步操作
 */
export async function logVisit(request, env, sub, path) {
  try {
    const [records, location] = await Promise.all([
      loadVisitors(env, sub),
      getLocation(request, env)
    ]);

    records.unshift({
      ip: getClientIP(request),
      time: new Date().toISOString(),
      path,
      ua: request.headers.get('User-Agent') || '',
      referer: request.headers.get('Referer') || '',
      location
    });

    if (records.length > MAX_RECORDS) {
      records.length = MAX_RECORDS;
    }

    await saveVisitors(env, sub, records);
  } catch (e) {
    console.error('logVisit error:', e);
  }
}

/**
 * 获取访客统计
 */
export async function getVisitors(request, env, sub) {
  try {
    const records = await loadVisitors(env, sub);
    const todayStr = new Date().toISOString().slice(0, 10);

    return new Response(JSON.stringify({
      total: records.length,
      today: records.filter(r => r.time?.startsWith(todayStr)).length,
      uniqueIPs: new Set(records.map(r => r.ip)).size,
      recent: records.slice(0, 50)
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

