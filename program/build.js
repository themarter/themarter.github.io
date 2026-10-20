#!/usr/bin/env node
/**
 * 构建流水线
 *
 *   1. 扫描 origin/ 下的页面（每个子目录里的 index.html + metadata.yaml）
 *   2. 用 EJS 渲染首页的「全部页面」索引
 *        template/ejs/pages-list.ejs  ->  template/generated/pages-list.html
 *   3. 调用 RenderBuild，把 origin/ 渲染成 public/（套上 template/layout.html）
 *   4. 清理输出目录里不该公开的文件（metadata.yaml），修正 404 标题
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = path.join(ROOT, 'origin');
const TEMPLATE = path.join(ROOT, 'template');
const GENERATED = path.join(TEMPLATE, 'generated');
const PUBLIC = path.join(ROOT, 'public');

const RESERVED_DIRS = new Set(['template', 'program', 'node_modules', 'public', 'log']);

function readYaml(file) {
    if (!fs.existsSync(file)) return {};
    try {
        return yaml.load(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
        console.warn(`[build] 解析失败，已跳过：${path.relative(ROOT, file)} (${err.message})`);
        return {};
    }
}

function formatDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().slice(0, 10);
}

/** 收集 origin/ 下可公开展示的页面 */
function collectPages() {
    const pages = [];
    if (!fs.existsSync(ORIGIN)) return pages;

    for (const entry of fs.readdirSync(ORIGIN, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        if (RESERVED_DIRS.has(entry.name)) continue;

        const dir = path.join(ORIGIN, entry.name);
        if (!fs.existsSync(path.join(dir, 'index.html'))) continue;

        const meta = readYaml(path.join(dir, 'metadata.yaml'));
        if (meta.published === false) continue;

        pages.push({
            slug: entry.name,
            url: `/${entry.name}/`,
            title: String(meta.title || entry.name),
            description: String(meta.description || ''),
            date: formatDate(meta.date),
            order: Number(meta.order) || 0,
            pagetype: meta.pagetype || 'page',
        });
    }

    // 置顶 order 大的在前；其次按日期倒序；最后按标题
    pages.sort(
        (a, b) =>
            b.order - a.order ||
            (b.date || '').localeCompare(a.date || '') ||
            a.title.localeCompare(b.title, 'zh-Hans-CN'),
    );
    return pages;
}

/** 渲染首页的页面索引片段 */
function renderPagesList(pages) {
    const source = path.join(TEMPLATE, 'ejs', 'pages-list.ejs');
    if (!fs.existsSync(source)) {
        console.warn('[build] 未找到 template/ejs/pages-list.ejs，跳过页面索引生成');
        return;
    }
    fs.mkdirSync(GENERATED, { recursive: true });

    const html = ejs.render(fs.readFileSync(source, 'utf8'), { pages }, { filename: source });
    fs.writeFileSync(path.join(GENERATED, 'pages-list.html'), html.trim() + '\n', 'utf8');
    console.log(`[build] 页面索引已生成，共 ${pages.length} 项`);
}

/** 移除构建产物里的 metadata.yaml，并修正 404 标题 */
function cleanOutput() {
    if (!fs.existsSync(PUBLIC)) return;

    let removed = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name === 'metadata.yaml') {
                fs.unlinkSync(full);
                removed += 1;
            }
        }
    };
    walk(PUBLIC);

    // 404 与首页共用 origin/metadata.yaml，标题单独覆盖
    const notFound = path.join(PUBLIC, '404.html');
    if (fs.existsSync(notFound)) {
        const siteName = readConfig().page.siteName;
        const html = fs
            .readFileSync(notFound, 'utf8')
            .replace(/<title>[\s\S]*?<\/title>/, `<title>页面走丢了 · ${siteName}</title>`);
        fs.writeFileSync(notFound, html, 'utf8');
    }

    if (removed > 0) console.log(`[build] 已清理 ${removed} 个 metadata.yaml`);
}

function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

async function build() {
    process.chdir(ROOT);

    const pages = collectPages();
    renderPagesList(pages);

    const RBuild = require('render-build');
    await RBuild.build('./');

    cleanOutput();

    if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
        throw new Error('构建结束但未生成 public/index.html，请检查 origin/index.html 与模板');
    }
    console.log(`[build] 完成 -> ${path.relative(ROOT, PUBLIC)}/`);
}

module.exports = { ROOT, ORIGIN, TEMPLATE, GENERATED, PUBLIC, collectPages, renderPagesList, cleanOutput, build };

if (require.main === module) {
    build().catch((err) => {
        console.error('[build] 构建失败：', err);
        process.exit(1);
    });
}
