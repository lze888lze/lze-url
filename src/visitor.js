/**
 * 访问统计模块
 *
 * 功能:
 *   - 记录每次访问的 IP、时间、User-Agent、路径
 *   - 根据子域名分类存储到 R2
 *   - 使用 ip2region xdb 查询精确 IP 归属地
 *   - 提供 /api/visitors 接口查看统计
 *
 * R2 存储路径:
 *   data/peilv/visitors.json
 *   data/peilv-admin/visitors.json
 */

const MAX_RECORDS = 5000; // 单文件最大记录数，防止文件过大

// ip2region xdb 缓存（Worker 全局只加载一次）
let xdbV4Cache = null;
let xdbV6Cache = null;

/**
 * 判断是否为 IPv6
 */
function isIPv6(ip) {
  return ip.includes(':');
}

/**
 * 从 R2 加载 ip2region xdb 文件到内存
 */
async function loadXdb(env) {
  if (xdbV4Cache && xdbV6Cache) return;

  try {
    const v4Obj = await env.PEILV_BUCKET.get('ipv4-ipv6/ip2region_v4.xdb');
    if (v4Obj) {
      xdbV4Cache = new Uint8Array(await v4Obj.arrayBuffer());
    }
  } catch (e) {
    console.error('load xdb v4 error:', e.message);
  }

  try {
    const v6Obj = await env.PEILV_BUCKET.get('ipv4-ipv6/ip2region_v6.xdb');
    if (v6Obj) {
      xdbV6Cache = new Uint8Array(await v6Obj.arrayBuffer());
    }
  } catch (e) {
    console.error('load xdb v6 error:', e.message);
  }
}

/**
 * 简单的 ip2region xdb 查询（二进制搜索）
 * 返回格式: 国家|区域|省份|城市|ISP
 */
function searchXdb(xdb, ip) {
  if (!xdb) return null;

  try {
    // 读取文件头
    const dataLen = xdb.length;
    const indexLen = readInt32(xdb, 0);
    const indexPtr = readInt32(xdb, 4);

    if (indexLen === 0 || indexPtr === 0) return null;

    // IP 转整数
    const ipInt = ipToLong(ip);
    if (ipInt === null) return null;

    // 二分搜索
    let low = 0;
    let high = (indexLen - 8) / 12;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const pos = indexPtr + mid * 12;

      const startIp = readInt32(xdb, pos);
      const endIp = readInt32(xdb, pos + 4);
      const dataPtr = readInt32(xdb, pos + 8) & 0x00FFFFFF;
      const dataLen2 = xdb[pos + 11];

      if (ipInt < startIp) {
        high = mid - 1;
      } else if (ipInt > endIp) {
        low = mid + 1;
      } else {
        // 找到匹配区间，读取 region 数据
        const regionBytes = xdb.slice(dataPtr, dataPtr + dataLen2);
        return new TextDecoder().decode(regionBytes);
      }
    }
  } catch (e) {
    console.error('searchXdb error:', e.message);
  }
  return null;
}

function readInt32(buf, offset) {
  return (buf[offset] & 0xFF) |
    ((buf[offset + 1] & 0xFF) << 8) |
    ((buf[offset + 2] & 0xFF) << 16) |
    ((buf[offset + 3] & 0xFF) << 24);
}

function ipToLong(ip) {
  // 处理 IPv4
  const parts = ip.split('.');
  if (parts.length === 4) {
    let num = 0;
    for (let i = 0; i < 4; i++) {
      const n = parseInt(parts[i], 10);
      if (isNaN(n) || n < 0 || n > 255) return null;
      num = (num << 8) + n;
    }
    return num >>> 0;
  }
  // IPv6 转 128 位大整数（用两个 64 位整数表示）
  return ipv6ToLong(ip);
}

/**
 * IPv6 转 128 位整数，返回 [high, low] 两个 64 位无符号整数
 */
function ipv6ToLong(ip) {
  try {
    // 处理 :: 压缩
    let full = ip;
    if (full.includes('::')) {
      const sides = full.split('::');
      const left = sides[0] ? sides[0].split(':') : [];
      const right = sides[1] ? sides[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      const middle = new Array(missing).fill('0');
      full = [...left, ...middle, ...right].join(':');
    }

    const groups = full.split(':');
    if (groups.length !== 8) return null;

    let high = 0n;
    let low = 0n;

    for (let i = 0; i < 4; i++) {
      high = (high << 16n) | BigInt(parseInt(groups[i] || '0', 16));
    }
    for (let i = 4; i < 8; i++) {
      low = (low << 16n) | BigInt(parseInt(groups[i] || '0', 16));
    }

    return [high, low];
  } catch (e) {
    return null;
  }
}

/**
 * 比较两个 128 位整数 [high, low]
 * 返回 -1, 0, 1
 */
function compare128(a, b) {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

/**
 * IPv6 xdb 搜索（索引项为 24 字节：startIp 16B + endIp 16B + dataPtr 4B + dataLen 4B）
 */
function searchXdbV6(xdb, ip) {
  if (!xdb) return null;

  try {
    const indexLen = readInt32(xdb, 0);
    const indexPtr = readInt32(xdb, 4);

    if (indexLen === 0 || indexPtr === 0) return null;

    const ipVal = ipv6ToLong(ip);
    if (!ipVal) return null;

    const itemSize = 24; // 16 + 16 + 4 + 4 = 24 字节（但实际 xdb v6 格式需确认）
    // ip2region v6 xdb 实际格式：startIp(16B) + endIp(16B) + dataPtr(4B) + dataLen(4B) = 24B
    let low = 0;
    let high = (indexLen - 8) / itemSize;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const pos = indexPtr + mid * itemSize;

      const startIp = readIPv6(xdb, pos);
      const endIp = readIPv6(xdb, pos + 16);
      const dataPtr = readInt32(xdb, pos + 32);
      const dataLen2 = readInt32(xdb, pos + 36);

      const cmpStart = compare128(ipVal, startIp);
      const cmpEnd = compare128(ipVal, endIp);

      if (cmpStart < 0) {
        high = mid - 1;
      } else if (cmpEnd > 0) {
        low = mid + 1;
      } else {
        const regionBytes = xdb.slice(dataPtr, dataPtr + dataLen2);
        return new TextDecoder().decode(regionBytes);
      }
    }
  } catch (e) {
    console.error('searchXdbV6 error:', e.message);
  }
  return null;
}

function readIPv6(buf, offset) {
  let high = 0n;
  let low = 0n;
  for (let i = 0; i < 8; i++) {
    high = (high << 8n) | BigInt(buf[offset + i]);
  }
  for (let i = 8; i < 16; i++) {
    low = (low << 8n) | BigInt(buf[offset + i]);
  }
  return [high, low];
}

/**
 * 获取访客真实 IP
 */
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
}

/**
 * 获取 IP 归属地
 * 优先使用 ip2region xdb，失败则回退到 Cloudflare cf 信息
 */
async function getLocation(request, env) {
  const ip = getClientIP(request);
  const cf = request.cf || {};

  // 加载 xdb
  await loadXdb(env);

  // 查询 ip2region
  let region = null;
  if (isIPv6(ip)) {
    region = searchXdbV6(xdbV6Cache, ip);
  } else {
    region = searchXdb(xdbV4Cache, ip);
  }

  if (region) {
    const parts = region.split('|');
    return {
      country: parts[0] || cf.country || '',
      region: parts[2] || cf.region || '',
      city: parts[3] || cf.city || '',
      isp: parts[4] || '',
      source: 'ip2region'
    };
  }

  // 回退到 Cloudflare 信息
  return {
    country: cf.country || '',
    region: cf.region || '',
    city: cf.city || '',
    isp: '',
    source: 'cf'
  };
}

/**
 * 读取现有访客数据
 */
async function loadVisitors(env, sub) {
  const key = `data/${sub}/visitors.json`;
  try {
    const object = await env.PEILV_BUCKET.get(key);
    if (!object) return [];
    const text = await object.text();
    return JSON.parse(text);
  } catch (e) {
    return [];
  }
}

/**
 * 保存访客数据
 */
async function saveVisitors(env, sub, records) {
  const key = `data/${sub}/visitors.json`;
  await env.PEILV_BUCKET.put(key, JSON.stringify(records, null, 2));
}

/**
 * 记录一次访问
 * @param {Request} request
 * @param {object} env
 * @param {string} sub - 子域名前缀 (如 'peilv', 'peilv-admin')
 * @param {string} path - 访问路径
 */
export async function logVisit(request, env, sub, path) {
  try {
    const records = await loadVisitors(env, sub);

    const record = {
      ip: getClientIP(request),
      time: new Date().toISOString(),
      path: path,
      ua: request.headers.get('User-Agent') || '',
      referer: request.headers.get('Referer') || '',
      location: await getLocation(request, env)
    };

    records.unshift(record); // 新记录放前面

    // 超出限制时截断旧记录
    if (records.length > MAX_RECORDS) {
      records.length = MAX_RECORDS;
    }

    await saveVisitors(env, sub, records);
  } catch (e) {
    // 统计失败不影响主业务
    console.error('logVisit error:', e.message);
  }
}

/**
 * 获取访客统计（供 API 调用）
 */
export async function getVisitors(request, env, sub) {
  try {
    const records = await loadVisitors(env, sub);

    // 简单统计
    const stats = {
      total: records.length,
      today: 0,
      uniqueIPs: new Set(records.map(r => r.ip)).size,
      recent: records.slice(0, 50) // 最近 50 条
    };

    const todayStr = new Date().toISOString().slice(0, 10);
    stats.today = records.filter(r => r.time && r.time.startsWith(todayStr)).length;

    return new Response(JSON.stringify(stats, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
