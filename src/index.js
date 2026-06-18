/**
 * lze-url - 泛域名路由 Worker
 * 绑定泛域名: *.lze.cc.cd
 *
 * 模块化架构:
 *   每个站点独立放在 src/<module>/ 目录下
 *   模块导出 { subdomains, folder, handle(request, env, indexFile, sub) }
 *   index.js 只负责路由分发
 *
 * 扩展新站点:
 *   1. 创建 src/<module>/<module>.js
 *   2. 在下方 import 并注册到 moduleMap
 */

import * as pei_lv from './pei_lv/pei_lv.js';
import * as docs from './docs/docs.js';
import * as hf_api from './hf-api/hf-api.js';
import { recordAccessToD1 } from './utils/access-log.js';

// ========== 模块注册 ==========
// 格式: '子域名': { handler: 模块, indexFile: '入口文件' }
// 支持一个模块绑定多个子域名（不同入口文件）
const moduleMap = {};

// 注册 pei_lv 模块
for (const [sub, indexFile] of Object.entries(pei_lv.subdomains)) {
  moduleMap[sub] = { handler: pei_lv, indexFile };
}

// 注册 docs 模块
for (const [sub, indexFile] of Object.entries(docs.subdomains)) {
  moduleMap[sub] = { handler: docs, indexFile };
}

// 注册 hf-api 模块
for (const [sub, indexFile] of Object.entries(hf_api.subdomains)) {
  moduleMap[sub] = { handler: hf_api, indexFile };
}

// ========== 主入口 ==========

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const sub = hostname.split('.')[0];

    // 查找匹配的模块
    const mod = moduleMap[sub];
    if (mod) {
      if (ctx?.waitUntil) {
        ctx.waitUntil(recordAccessToD1(request, env, sub));
      }

      return await mod.handler.handle(request, env, mod.indexFile, sub, ctx);
    }

    // 未匹配的子域名返回 404
    return new Response('404 Not Found', { status: 404 });
  }
};
