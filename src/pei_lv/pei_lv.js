/**
 * pei_lv 模块 - 赔率数据站点
 *
 * 子域名:
 *   peilv.lze.cc.cd       -> 访客端 (index.html)
 *   peilv-admin.lze.cc.cd -> 管理端 (admin.html)
 *
 * R2 文件夹: pei_lv/
 * API:
 *   GET  /api/data     - 获取比赛数据
 *   POST /api/data     - 保存比赛数据
 *   GET  /api/analysis - 获取球队分析
 *   POST /api/analysis - 保存球队分析
 */

// ========== 工具函数 ==========

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function getContentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

// ========== R2 服务 ==========

async function serveR2(env, path) {
  try {
    const object = await env.PEILV_BUCKET.get(path);
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const contentType = getContentType(path);
    const headers = {
      'Content-Type': contentType,
      ...corsHeaders()
    };

    // 静态资源缓存
    if (/\.(css|js|png|jpg|ico|svg|woff2?)$/.test(path)) {
      headers['Cache-Control'] = 'public, max-age=2592000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache, no-store';
    }

    return new Response(object.body, { headers });
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}

// ========== API 接口 ==========

async function handleGetData(env, folder) {
  try {
    const key = folder + '/match-data.json';
    const object = await env.PEILV_BUCKET.get(key);
    if (!object) {
      return jsonResponse({ error: 'No data found' }, 404);
    }
    const data = await object.text();
    return new Response(data, {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function handlePostData(request, env, folder) {
  try {
    const key = folder + '/match-data.json';
    const body = await request.json();
    await env.PEILV_BUCKET.put(key, JSON.stringify(body, null, 2));
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function handleGetAnalysis(env, folder) {
  try {
    const key = folder + '/analysis.json';
    const object = await env.PEILV_BUCKET.get(key);
    if (!object) {
      return jsonResponse({ content: '' });
    }
    const data = await object.json();
    return jsonResponse(data);
  } catch (e) {
    return jsonResponse({ content: '' });
  }
}

async function handlePostAnalysis(request, env, folder) {
  try {
    const key = folder + '/analysis.json';
    const body = await request.json();
    await env.PEILV_BUCKET.put(key, JSON.stringify(body, null, 2));
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ========== 模块导出 ==========

/**
 * 子域名 -> 入口文件映射
 */
export const subdomains = {
  'peilv': 'index.html',
  'peilv-admin': 'admin.html'
};

/**
 * R2 文件夹名
 */
export const folder = 'pei_lv';

/**
 * 处理请求的主入口
 * @param {Request} request
 * @param {object} env - Cloudflare Worker 环境变量
 * @param {string} indexFile - 该子域名对应的入口文件
 * @returns {Response}
 */
export async function handle(request, env, indexFile) {
  const url = new URL(request.url);

  // API: 比赛数据
  if (url.pathname === '/api/data') {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method === 'GET') {
      return await handleGetData(env, folder);
    }
    if (request.method === 'POST') {
      return await handlePostData(request, env, folder);
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // API: 球队分析
  if (url.pathname === '/api/analysis') {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method === 'GET') {
      return await handleGetAnalysis(env, folder);
    }
    if (request.method === 'POST') {
      return await handlePostAnalysis(request, env, folder);
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // 静态资源从 R2 读取
  const file = url.pathname === '/' ? indexFile : url.pathname.slice(1);
  const path = folder + '/' + file;
  return await serveR2(env, path);
}
