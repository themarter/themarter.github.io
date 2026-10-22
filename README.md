# Marter 的个人空间

静态站点，基于 [RenderBuild](https://github.com/RavelloH/RenderBuild) 构建，GitHub Actions 自动发布到 GitHub Pages。

线上地址：<https://themarter.github.io/>

本地工作副本：`D:\迅雷下载\marter's space`（以此为准）

## 目录结构

```
origin/                     # 页面源文件（内容）
├── index.html              # 首页
├── 404.html                # 404
├── metadata.yaml           # 首页的标题 / 描述
├── favicon.svg
├── assets/spine/           # 看板娘资源（Spine 3.8 运行时 + 特蕾西娅模型）
│   ├── spine-webgl-3.8.js
│   ├── theresa-widget.js   # 挂件逻辑（拖动 / 点击换动作 / 位置记忆）
│   ├── theresa-widget.css
│   └── theresa/            # atlas + skel + png（enemy_1554_lrtsia）
└── <slug>/
    ├── index.html          # 页面正文（片段，自动套用全局布局）
    └── metadata.yaml       # 标题 / 描述 / 日期

template/                   # 版式（壳）
├── layout.html             # 主模板：<head>、页头、页脚，全局唯一
├── static/
│   ├── analytics.html      # ★ 统计脚本模板（全局注入所有页面）
│   ├── theresa.html        # ★ 看板娘引用（全局注入所有页面）
│   └── styles.html         # 全站样式
├── ejs/
│   └── pages-list.ejs      # 首页「全部页面」索引的 EJS 模板
└── generated/              # 构建时生成，不入库

program/
├── build.js                # 构建流水线
├── dev.js                  # 本地预览（热更新）
└── publish.js              # 发布一份 HTML 到 origin/
```

## 常用命令

```bash
npm install        # 首次
npm run dev        # 本地预览 http://127.0.0.1:8080
npm run build      # 构建到 public/
npm run publish -- ./some-page.html some-page   # 发布一份 HTML
```

## 发布一份页面

```bash
npm run publish -- ./report.html my-report --title "我的报告" --desc "一句话描述"
```

脚本会把 HTML 放进 `origin/my-report/index.html`，生成对应的 `metadata.yaml`，
并复制它引用到的本地图片/样式。它是完整 HTML 文档时，会抽出 `<body>` 内容并把
`<head>` 里的 `<style>` / `<link>` / `<script>` 一并带过去；是片段时自动包一层
`<article class="article">` 套用站点排版。

加上 `--push` 会顺手构建、提交并推送，GitHub Actions 随即部署。

## 新增页面（手工）

```
origin/<slug>/index.html
origin/<slug>/metadata.yaml
```

```yaml
title: 页面标题
description: 一句话描述（会出现在首页列表）
date: 2026-10-20
order: 10        # 可选，越大越靠前
published: true  # 可选，false 则不出现在首页列表
theresa: false   # 可选，这一页不挂右下角看板娘（连脚本都不加载）
```

首页的页面列表由 `template/ejs/pages-list.ejs` 渲染，构建时扫描 `origin/` 自动生成，
无需手工维护。

## 特蕾西娅看板娘（右下角）

全站生效，由 `template/static/theresa.html` 引入，`template/layout.html` 在 `</body>` 前挂载。

- **拖动**：按住模型拖到任意位置，位置记在 `localStorage`，下次访问还在原处；刷新后不跑位，窗口变小时会自动收进可视区域
- **单击**：换一个动作（`C1_Skill_3` / `C1_Skill_4` / `C3_Attack`，放完自动回到 `C1_Idle`）
- **双击**：归位到右下角
- **右上角 ×**：本次会话隐藏（关掉标签页再开就又有了）
- 窗口宽度 < 480px 时自动不加载，省流量；`document.hidden` 时暂停渲染

某一页不想要看板娘（比如 `/liar/`），在该页的 `metadata.yaml` 写 `theresa: false`，
构建时整段引用都不会输出。彻底不想要：删掉 `template/layout.html` 里的 `{{static/theresa.html}}`。

技术：官方 spine-webgl **3.8** 运行时（`origin/assets/spine/spine-webgl-3.8.js`）+ RenderBuild 静态托管。
模型是 `enemy_1554_lrtsia`（3.8 二进制 skel / atlas / png，合计约 470KB），首屏用 `defer` 异步加载，
不阻塞页面；模型数据用 `fetch` 拿，纹理预加载后才建 `GLTexture`（否则 atlas 的 UV 会按 0 尺寸算错）。

换模型：把新的 `.atlas` / `.skel` / `.png` 放进 `origin/assets/spine/theresa/`，
改 `theresa-widget.js` 顶部 `CONFIG` 的 `atlas` / `skel` / `texture` / `idle` / `actions` 即可。
同目录下可选的另两只：`enemy_3006_tersia`（“魔王”）、`enemy_3007_lrssia`（“演出”），
从 [Ark-Models](https://github.com/isHarryh/Ark-Models) 的 `models_enemies/` 按需下载。

> 素材版权归上海鹰角网络所有，仓库说明为“仅供学习交流，请勿商用”。

## 统计脚本

`template/static/analytics.html`，被 `template/layout.html` 引用，因此对全站所有页面生效
（含首页、内容页、404）。换统计服务只改这一个文件。

## 密码相册（/album/）

静态站没有服务端，"密码"如果只在 JS 里判断，直接访问图片地址就绕过去了。所以这里是**真加密**：
照片用密码派生的密钥（PBKDF2-SHA256, 25 万次迭代）加密成 AES-256-GCM 密文再上传，
浏览器里输对密码才解得开。仓库里没有密码，也没有明文照片。

**放照片**

```bash
# 1. 把照片丢进 photos/（这个目录的内容不会进仓库）
# 2. 加密并生成清单
ALBUM_PASSWORD=你的密码 node program/album.js ./photos
# 3. 构建、推送
npm run build && git add -A && git commit -m "album: 更新照片" && git push
```

清空相册（保留空册）：`ALBUM_PASSWORD=… node program/album.js --clear`

**做了什么**

- 每张照片转两版 JPEG：正片长边 2000（q3）、缩略图长边 480（q5），都加密
- 转码时 `-map_metadata -1`，把 EXIF（含 GPS）丢掉
- `origin/assets/album/manifest.json` 只有盐、迭代次数、每张图的 IV 和尺寸，没有明文
- 前端：缩略图滚到视口才解密；点开才解密正片；密钥存 `sessionStorage`，刷新这个标签页免重输；
  「锁定」按钮清掉密钥回到密码门
- 瀑布流用 `grid-auto-rows: 6px` + 按图片比例算行跨度，图片有 `aspect-ratio` 占位，
  不解密也知道每格多高，加载时不跳版

**注意**

- 密码别写进仓库，也别写进 README；脚本只从 `ALBUM_PASSWORD` 或 `--password` 取
- 已经推上去的旧密文用旧密码加密；换密码要重新跑一遍脚本（所有照片都会重新加密）
- 忘了密码 = 照片解不回来，原图只在你本地 `photos/` 里

## 部署

`.github/workflows/deploy.yml`：推送到 `main` 后自动 `npm ci` → `npm run build` →
上传 `public/` 制品 → 部署到 GitHub Pages。Pages 的源已设为「GitHub Actions」，
不再需要 gh-pages 分支，也不需要把构建产物提交进仓库。

## 模板语法速查（RenderBuild）

| 写法 | 含义 |
| --- | --- |
| `{{static/styles.html}}` | 引入模板文件（相对当前文件） |
| `{{{doc}}}` | 当前页面正文（由 layout 使用） |
| `{{{siteName}}}` | 取 `config.json` 里 `page.siteName` 的值 |
| `<% if (...) { %> … <% } %>` | EJS 逻辑，可读取 `title` / `description` / `pagetype` 等 |
