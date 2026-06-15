/**
 * lze-url - 泛域名 IP 优选 + 反向代理 Worker
 * 绑定泛域名: *.lze.cc.cd
 *
 * R2 桶: lze-url
 * 子域名自动映射到 R2 同名文件夹:
 *   peilv.lze.cc.cd       -> R2: pei_lv/ (访客端 index.html)
 *   peilv-admin.lze.cc.cd -> R2: pei_lv/ (管理端 admin.html)
 *   xxx.lze.cc.cd         -> R2: xxx/    (以后扩展)
 *
 * 其他子域名保持原有转发逻辑
 */

// 子域名 -> R2 文件夹映射（可扩展）
const siteMap = {
  'peilv': 'pei_lv',
  'peilv-admin': 'pei_lv'
};

// 子域名转发映射（原有逻辑保留）
const hostMap = {
  '': 'lze.pages.dev',
  'www': 'lze.pages.dev',
  'cmd': 'cmd-form.pages.dev',
  'dosc': 'dosc.pages.dev'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const sub = hostname.split('.')[0];

    // ========== R2 静态网站路由 ==========

    const folder = siteMap[sub];
    if (folder) {
      // API 请求（pei_lv 专用）
      if (folder === 'pei_lv' && url.pathname === '/api/data') {
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

      // 静态资源从 R2 读取
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const path = folder + '/' + file;
      return await serveR2(env, path);
    }

    // ========== 原有泛域名转发逻辑 ==========

    const target = hostMap[sub];
    if (!target) {
      return new Response('404 Not Found', { status: 404 });
    }

    // 复制请求头，注入真实访客 IP
    const newHeaders = new Headers(request.headers);
    const realIP = request.headers.get('CF-Connecting-IP') || request.cf?.connectingIp;
    if (realIP) {
      newHeaders.set('X-Forwarded-For', realIP);
      newHeaders.set('X-Real-IP', realIP);
    }

    const targetUrl = new URL(url.pathname + url.search, `https://${target}`);
    const newReq = new Request(targetUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: 'follow'
    });

    let res = await fetch(newReq);
    const h = new Headers(res.headers);

    // Cookie 域名修改
    const setCookieList = h.getAll('set-cookie');
    h.delete('set-cookie');
    for (let ck of setCookieList) {
      ck = ck.replace(/Domain=[^;]+;/gi, 'Domain=.lze.cc.cd;');
      h.append('set-cookie', ck);
    }

    // 缓存规则
    if (/\.(css|js|png|jpg|ico|svg|woff2?|md)$/.test(url.pathname)) {
      h.set('Cache-Control', 'public, max-age=2592000, immutable');
    } else {
      h.set('Cache-Control', 'no-cache, no-store');
    }

    return new Response(res.body, { headers: h, status: res.status });
  }
};

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
