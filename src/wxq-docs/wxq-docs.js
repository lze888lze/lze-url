/**
 * wxq-docs 模块 - APK 使用说明站点
 *
 * 子域名: wxq-docs.lze.cc.cd -> index.html
 *
 * R2 文件夹: wxq-docs/
 * 静态资源（图片、安装包、附件）统一放在 R2 的 wxq-docs/ 目录下
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
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.apk')) return 'application/vnd.android.package-archive';
  if (path.endsWith('.exe')) return 'application/octet-stream';
  if (path.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

async function serveR2(env, path) {
  try {
    const object = await env.PEILV_BUCKET.get(path);
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const contentType = getContentType(path);
    const headers = {
      'Content-Type': contentType,
      ...corsHeaders(),
      'Cache-Control': 'no-store, no-cache'
    };

    return new Response(object.body, { headers });
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}

// ========== 模块导出 ==========

export const subdomains = {
    'wxq-docs': 'index.html'
};

export const folder = 'wxq-docs';

export async function handle(request, env, indexFile, sub) {
  const url = new URL(request.url);

  const file = url.pathname === '/' ? indexFile : url.pathname.slice(1);
  // 路径规范化，防止 ../ 穿越到其他目录
  const safeFile = file.split('/').filter(seg => seg && seg !== '..').join('/');
  const path = folder + '/' + safeFile;
  return await serveR2(env, path);
}
