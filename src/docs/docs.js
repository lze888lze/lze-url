/**
 * docs 模块 - 文档站点
 *
 * 子域名: docs.lze.cc.cd -> index.html
 *
 * R2 文件夹: docs/
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
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

async function serveR2(env, path, request) {
  const cache = caches.default;
  const cacheKey = new URL(request.url);

  // 1) 先查边缘缓存，命中直接返回
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

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

    // css/js/img：浏览器 30 天 + 边缘 30 天
    if (/\.(css|js|png|jpg|ico|svg|woff2?)$/.test(path)) {
      headers['Cache-Control'] = 'public, max-age=2592000, s-maxage=2592000, immutable';
    } else {
      // html：浏览器 60 秒 + 边缘 1 天（更新后去 CF 控制台 Purge Cache 即可）
      headers['Cache-Control'] = 'public, max-age=60, s-maxage=86400';
    }

    const response = new Response(object.body, { headers });

    // 2) 放进边缘缓存（clone 因为 body 只能读一次）
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}

// ========== 模块导出 ==========

export const subdomains = {
  'docs': 'index.html'
};

export const folder = 'docs';

export async function handle(request, env, indexFile, sub) {
  const url = new URL(request.url);

  const file = url.pathname === '/' ? indexFile : url.pathname.slice(1);
  // 路径规范化，防止 ../ 穿越到其他目录
  const safeFile = file.split('/').filter(seg => seg && seg !== '..').join('/');
  const path = folder + '/' + safeFile;
  return await serveR2(env, path, request);
}
