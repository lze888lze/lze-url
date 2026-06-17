// ============================================================
// hf-api 模块 - Hugging Face 图片处理 API 代理
// 功能：记录访问统计 → 代理到 Hugging Face API
// 子域名：hf-api.lze.cc.cd
// KV Key 格式：国家+省份+IP（如：中国广东240.12.34.56）
// KV Value 格式：{"次数":2,"time":"2026/5/28 06:43:00","尾缀":{"sl":[0,0],"ho":[0,0],"pz":[2,0],"vz":[0,0]}}
// ============================================================

import { lookupProvince } from './ipv6-province.js';

const TYPE_CONFIG = {
  'slide': { stats: 'sl', mode: 0, target: 'slide' },
  'slide-base64': { stats: 'sl', mode: 1, target: 'slide-base64' },
  'hole': { stats: 'ho', mode: 0, target: 'hole' },
  'hole-base64': { stats: 'ho', mode: 1, target: 'hole-base64' },
  'puzzle': { stats: 'pz', mode: 0, target: 'puzzle' },
  'puzzle-base64': { stats: 'pz', mode: 1, target: 'puzzle-base64' },
  'visualize': { stats: 'vz', mode: 0, target: 'visualize' },
  'visualize-base64': { stats: 'vz', mode: 1, target: 'visualize-base64' },
};

const HF_BASE_URL = 'https://lze888lze-hf-api.hf.space';
const ALLOWED_PATHS = Object.keys(TYPE_CONFIG).join(', ');

const DEFAULT_DATA = {
  '次数': 0,
  '尾缀': { 'sl': [0, 0], 'ho': [0, 0], 'pz': [0, 0], 'vz': [0, 0] },
  'time': ''
};

const MUNICIPALITIES = ['北京', '上海', '天津', '重庆'];

const COUNTRY_MAP = {
  'CN': '中国', 'US': '美国', 'JP': '日本', 'KR': '韩国', 'GB': '英国',
  'DE': '德国', 'FR': '法国', 'AU': '澳大利亚', 'CA': '加拿大', 'RU': '俄罗斯',
  'SG': '新加坡', 'MY': '马来西亚', 'TH': '泰国', 'VN': '越南',
  'TW': '中国台湾', 'HK': '中国香港', 'MO': '中国澳门',
};

const REGION_MAP = {
  'Anhui': '安徽', 'Beijing': '北京', 'Chongqing': '重庆', 'Fujian': '福建',
  'Gansu': '甘肃', 'Guangdong': '广东', 'Guangxi': '广西', 'Guizhou': '贵州',
  'Hainan': '海南', 'Hebei': '河北', 'Heilongjiang': '黑龙江', 'Henan': '河南',
  'Hubei': '湖北', 'Hunan': '湖南', 'Inner Mongolia': '内蒙古', 'Jiangsu': '江苏',
  'Jiangxi': '江西', 'Jilin': '吉林', 'Liaoning': '辽宁', 'Ningxia': '宁夏',
  'Qinghai': '青海', 'Shaanxi': '陕西', 'Shandong': '山东', 'Shanghai': '上海',
  'Shanxi': '山西', 'Sichuan': '四川', 'Tianjin': '天津', 'Tibet': '西藏',
  'Xinjiang': '新疆', 'Yunnan': '云南', 'Zhejiang': '浙江',
  'Hong Kong': '香港', 'Macau': '澳门',
};

export const subdomains = {
  'hf-api': 'hf-api'
};

export const folder = 'hf_proxy';

export async function handle(request, env, indexFile, sub, ctx) {
  const url = new URL(request.url);
  const cleanPath = url.pathname.replace(/^\/+/, '');
  const typeConfig = TYPE_CONFIG[cleanPath];

  if (!typeConfig) {
    return jsonResponse({
      error: '403 Forbidden',
      msg: `该路径不在白名单内，仅允许访问: ${ALLOWED_PATHS}`
    }, 403);
  }

  const realIP = request.headers.get('cf-connecting-ip') || 'unknown_ip';

  if (ctx?.waitUntil) {
    ctx.waitUntil(recordStats(request, env, realIP, typeConfig));
  } else {
    await recordStats(request, env, realIP, typeConfig);
  }

  return proxyToTarget(request, HF_BASE_URL, typeConfig.target);
}

async function recordStats(request, env, realIP, typeConfig) {
  try {
    if (!env.lze) {
      console.error('KV 绑定 env.lze 不存在，已跳过访问统计');
      return;
    }

    const location = getLocation(request, realIP);
    const kvKey = `${location}${realIP}`;
    const data = await loadKVData(env, kvKey);

    data['次数'] += 1;
    data['time'] = getBeijingTime();
    data['尾缀'][typeConfig.stats][typeConfig.mode] += 1;

    await env.lze.put(kvKey, JSON.stringify(data));
  } catch (e) {
    console.error('KV 记录失败:', e);
  }
}

function getLocation(request, ip) {
  const ipv6Province = lookupProvince(ip);
  if (ipv6Province) {
    if (ipv6Province.startsWith('中国')) {
      return ipv6Province;
    }
    return '中国' + ipv6Province + (MUNICIPALITIES.includes(ipv6Province) ? '市' : '省');
  }

  const cf = request.cf || {};
  const country = cf.country || '';
  const region = cf.region || '';
  return buildLocationFromCF(country, region);
}

function buildLocationFromCF(country, region) {
  const co = COUNTRY_MAP[country] || country || '未知';
  const pr = REGION_MAP[region] || region || '';
  if (co === '中国' && pr) {
    if (MUNICIPALITIES.includes(pr)) {
      return co + pr + '市';
    }
    return co + pr + '省';
  }
  if (pr) return co + pr;
  return co;
}

async function loadKVData(env, key) {
  const raw = await env.lze.get(key);
  if (!raw) return cloneDefaultData();

  try {
    const data = JSON.parse(raw);
    const suffix = data['尾缀'] || {};

    return {
      '次数': typeof data['次数'] === 'number' ? data['次数'] : 0,
      '尾缀': {
        'sl': Array.isArray(suffix['sl']) ? suffix['sl'] : [0, 0],
        'ho': Array.isArray(suffix['ho']) ? suffix['ho'] : [0, 0],
        'pz': Array.isArray(suffix['pz']) ? suffix['pz'] : [0, 0],
        'vz': Array.isArray(suffix['vz']) ? suffix['vz'] : [0, 0],
      },
      'time': data['time'] || ''
    };
  } catch (e) {
    return cloneDefaultData();
  }
}

function cloneDefaultData() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function getBeijingTime() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

async function proxyToTarget(request, baseUrl, endpoint) {
  const targetUrl = `${baseUrl}/${endpoint}`;
  try {
    return await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  } catch (e) {
    return jsonResponse({
      error: 'Proxy Failed',
      msg: e.message
    }, 502);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
