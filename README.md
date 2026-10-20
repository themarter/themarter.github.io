# Marter 的个人空间

静态站点，基于 [RenderBuild](https://github.com/RavelloH/RenderBuild) 构建，GitHub Actions 自动发布到 GitHub Pages。

线上地址：<https://themarter.github.io/>

## 目录结构

```
origin/                     # 页面源文件（内容）
├── index.html              # 首页
├── 404.html                # 404
├── metadata.yaml           # 首页的标题 / 描述
├── favicon.svg
└── <slug>/
    ├── index.html          # 页面正文（片段，自动套用全局布局）
    └── metadata.yaml       # 标题 / 描述 / 日期

template/                   # 版式（壳）
├── layout.html             # 主模板：<head>、页头、页脚，全局唯一
├── static/
│   ├── analytics.html      # ★ 统计脚本模板（全局注入所有页面）
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
```

首页的页面列表由 `template/ejs/pages-list.ejs` 渲染，构建时扫描 `origin/` 自动生成，
无需手工维护。

## 统计脚本

`template/static/analytics.html`，被 `template/layout.html` 引用，因此对全站所有页面生效
（含首页、内容页、404）。换统计服务只改这一个文件。

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
