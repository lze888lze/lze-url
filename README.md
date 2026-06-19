# 托管站点一览

域名基础：`lze.cc.cd`

## 站点列表

| 子域名 | 站点 | 说明 |
|---|---|---|
| `peilv.lze.cc.cd` | 赔率数据站（访客端） | R2 静态站点，提供 `/api/data` 与 `/api/analysis` 接口 |
| `peilv-admin.lze.cc.cd` | 赔率数据站（管理端） | 同上，可写入比赛数据与球队分析 |
| `docs.lze.cc.cd` | 文档站 | R2 静态站点 |
| `hf-api.lze.cc.cd` | 图片处理 API 代理 | 反代理到 Hugging Face Space |
| `logs.lze.cc.cd` | 访问日志看板 | 查看所有子域名的访问记录（需登录） |

## 技术栈

- **Worker**：Cloudflare Workers（泛域名路由）
- **存储**：Cloudflare R2（静态资源）+ D1（访问日志）
- **D1 表**：`access_logs`（访问日志）
- **R2 目录**：`pei_lv/`（赔率数据）、`docs/`（文档）

## 源码结构

```
src/
├── index.js                 # 入口：泛域名路由
├── hf-api/hf-api.js      # HF API 代理
├── pei_lv/pei_lv.js       # 赔率数据站
├── docs/docs.js           # 文档站
├── logs/logs.js           # 日志看板
└── utils/access-log.js     # IP 归属地查询 + D1 写入
```
