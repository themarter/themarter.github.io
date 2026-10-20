#!/usr/bin/env node
/**
 * 把一份 HTML 发布到个人空间
 *
 *   npm run publish -- <文件路径> [slug] [--title "标题"] [--desc "描述"] [--date 2026-10-20] [--push]
 *
 * 行为：
 *   1. 读取 HTML。若它是完整文档（含 <html>），抽出 <body> 内容，并把 <head> 里的
 *      <style> / <link rel=stylesheet> / <script> 一并带到页面里，保留原有样式与脚本。
 *      若它是片段，自动包一层 <article class="article"> 以套用站点排版。
 *   2. 写入 origin/<slug>/index.html 与 origin/<slug>/metadata.yaml
 *   3. 复制页面引用到的本地图片/样式等相对资源
 *   4. 提示预览命令；带 --push 时直接构建、提交并推送到 GitHub
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cheerio = require('cheerio');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = path.join(ROOT, 'origin');

const ASSET_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico',
    '.css', '.js', '.json', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3',
]);

function parseArgs(argv) {
    const opts = { file: '', slug: '', title: '', desc: '', date: '', push: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--push') opts.push = true;
        else if (arg === '--title') opts.title = argv[++i] || '';
        else if (arg === '--desc') opts.desc = argv[++i] || '';
        else if (arg === '--date') opts.date = argv[++i] || '';
        else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
        else rest.push(arg);
    }
    opts.file = rest[0] || '';
    opts.slug = rest[1] || '';
    return opts;
}

function slugify(input) {
    const cleaned = String(input)
        .trim()
        .replace(/\.(html?|htm)$/i, '')
        .replace(/\s+/g, '-')
        .replace(/[^\w\u4e00-\u9fa5.-]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
    return cleaned || `page-${Date.now()}`;
}

function today() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function isRemote(url) {
    return /^(https?:)?\/\//i.test(url) || /^(data|mailto|tel):/i.test(url) || url.startsWith('#');
}

/** 提取页面，返回 { html, title, description, assets } */
function extract(sourcePath, raw, opts) {
    const isFullDoc = /<html[\s>]/i.test(raw);
    const $ = cheerio.load(raw, { decodeEntities: false });

    let title = opts.title || $('title').first().text().trim();
    const description =
        opts.desc || ($('meta[name="description"]').attr('content') || '').trim();

    const assets = new Set();
    $('[src], link[href]').each((_, el) => {
        const url = $(el).attr('src') || $(el).attr('href') || '';
        if (!url || isRemote(url) || url.startsWith('/')) return;
        const ext = path.extname(url.split('?')[0]).toLowerCase();
        if (ext === '.html' || ext === '.htm') return;
        assets.add(url.split('?')[0]);
    });

    let body;
    if (isFullDoc) {
        const head = [];
        $('head style, head link[rel="stylesheet"], head script').each((_, el) => {
            head.push($.html(el));
        });
        body = `${head.join('\n')}\n${$('body').html() || ''}`.trim();
    } else {
        body = raw.trim();
        // 片段：若没有自己的一级容器，就套用站点文章排版
        const hasRootContainer = /^\s*<(article|section|main|div)\b/i.test(body);
        if (!hasRootContainer) body = `<article class="article">\n${body}\n</article>`;
    }

    if (!title) title = path.basename(sourcePath).replace(/\.html?$/i, '');
    return { html: body, title, description, assets };
}

function copyAssets(assets, sourceDir, targetDir) {
    let copied = 0;
    for (const rel of assets) {
        const from = path.resolve(sourceDir, rel);
        const to = path.resolve(targetDir, rel);
        if (!to.startsWith(path.resolve(targetDir))) continue; // 防止越界
        if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
        if (!ASSET_EXT.has(path.extname(from).toLowerCase())) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        copied += 1;
    }
    return copied;
}

function push() {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    run('node', [path.join('program', 'build.js')]);
    run('git', ['add', '-A']);
    try {
        run('git', ['commit', '-m', `publish: ${new Date().toISOString().slice(0, 10)}`]);
    } catch {
        console.log('[publish] 没有新的改动，跳过提交');
    }
    run('git', ['push']);
    console.log('[publish] 已推送，GitHub Actions 会在 1 分钟左右完成部署');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.file) {
        console.error('用法：npm run publish -- <html文件> [slug] [--title "标题"] [--desc "描述"] [--date YYYY-MM-DD] [--push]');
        process.exit(1);
    }

    const sourcePath = path.resolve(process.cwd(), opts.file);
    if (!fs.existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`);

    const raw = fs.readFileSync(sourcePath, 'utf8');
    const page = extract(sourcePath, raw, opts);
    const slug = slugify(opts.slug || path.basename(sourcePath));
    const targetDir = path.join(ORIGIN, slug);

    if (fs.existsSync(targetDir)) console.log(`[publish] 目标已存在，将覆盖：origin/${slug}/`);
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(path.join(targetDir, 'index.html'), page.html.trim() + '\n', 'utf8');
    fs.writeFileSync(
        path.join(targetDir, 'metadata.yaml'),
        yaml.dump(
            {
                title: page.title,
                description: page.description,
                date: opts.date || today(),
                pagetype: 'page',
            },
            { lineWidth: -1, quotingType: '"' },
        ),
        'utf8',
    );

    const copied = copyAssets(page.assets, path.dirname(sourcePath), targetDir);

    console.log(`[publish] origin/${slug}/index.html`);
    console.log(`[publish] 标题：${page.title}`);
    if (copied) console.log(`[publish] 已复制 ${copied} 个本地资源`);
    console.log(`[publish] 地址：/${slug}/`);

    if (opts.push) push();
    else console.log('[publish] 预览：npm run dev    发布：npm run build && git commit/push（或加 --push）');
}

try {
    main();
} catch (err) {
    console.error('[publish] 失败：', err.message);
    process.exit(1);
}
