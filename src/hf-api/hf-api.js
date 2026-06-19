// ============================================================
// hf-api 模块 - Hugging Face 图片处理 API 代理
// 子域名：hf-api.lze.cc.cd
// 访问统计：已由 index.js 的 D1 记录覆盖，不再单独写 KV
// ============================================================

const HF_BASE_URL = 'https://lze888lze-hf-api.hf.space';

const ALLOWED_PATHS = new Set([
  'slide', 'slide-base64',
  'hole', 'hole-base64',
  'puzzle', 'puzzle-base64',
  'visualize', 'visualize-base64',
  'ip'
]);

export const subdomains = {
  'hf-api': 'hf-api'
};

export const folder = 'hf_proxy';

export async function handle(request, env, indexFile, sub, ctx) {
  const url = new URL(request.url);
  const cleanPath = url.pathname.replace(/^\/+/, '');

  if (!ALLOWED_PATHS.has(cleanPath)) {
    return jsonResponse({
      error: '403 Forbidden',
      msg: `该路径不在白名单内，仅允许访问: ${[...ALLOWED_PATHS].join(', ')}`
    }, 403);
  }

  return proxyToTarget(request, HF_BASE_URL, cleanPath);
}

async function proxyToTarget(request, baseUrl, endpoint) {
  const sourceUrl = new URL(request.url);
  const targetUrl = `${baseUrl}/${endpoint}${sourceUrl.search}`;
  const method = request.method.toUpperCase();
  try {
    return await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : request.body
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
