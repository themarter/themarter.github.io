#!/usr/bin/env node
/**
 * 一条命令更新线上相册：加密 photos/ → 构建 → 提交 → 推送
 *
 *   npm run album            # 只加密 + 构建，不提交（想先看看效果）
 *   npm run album:deploy     # 加密 + 构建 + 提交 + 推送，等 GitHub Actions 部署
 *
 * 密码从 .album-password（推荐，本机文件、已被忽略）或 ALBUM_PASSWORD 读取。
 * photos/ 里放照片，文件名按顺序排（01-xx.jpg、02-xx.jpg…）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'origin', 'assets', 'album');
const argv = process.argv.slice(2);
const NO_PUSH = argv.includes('--no-push');
const NO_BUILD = argv.includes('--no-build');
const DIR = (() => {
    const i = argv.findIndex((a) => a === '--dir');
    return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(ROOT, 'photos');
})();

const step = (text) => console.log(`\n▸ ${text}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(bin, args, options = {}) {
    const result = spawnSync(bin, args, {
        cwd: ROOT,
        stdio: options.capture ? 'pipe' : 'inherit',
        encoding: 'utf8',
    });
    if (options.allowFail) return result;
    if (result.status !== 0) {
        const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
        console.error(detail ? `\n${detail}` : '');
        process.exit(result.status || 1);
    }
    return result;
}

/* ---------- 1. 加密 ---------- */

step('加密照片');
run(process.execPath, [path.join(__dirname, 'album.js'), DIR, ...(argv.includes('--clear') ? ['--clear'] : [])]);

const manifestPath = path.join(OUT_DIR, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const total = manifest.items.length;

/* ---------- 2. 构建 ---------- */

if (!NO_BUILD) {
    step('构建站点');
    run(process.execPath, [path.join(__dirname, 'build.js')]);
}

console.log(`\n相册现有 ${total} 张照片。`);

if (NO_PUSH) {
    console.log('（--no-push：没有提交，也没有推送）');
    console.log('本地预览：npm run dev');
    process.exit(0);
}

/* ---------- 3. 提交 ---------- */

step('提交改动');
run('git', ['add', '-A']);
const dirty = run('git', ['status', '--porcelain'], { capture: true }).stdout.trim();

if (!dirty) {
    console.log('没有变化，无需提交。');
    process.exit(0);
}

const message = total > 0 ? `album: 更新照片（${total} 张）` : 'album: 清空照片';
run('git', [
    '-c', 'user.name=Marter',
    '-c', 'user.email=11695@users.noreply.github.com',
    'commit', '-q', '-m', message,
]);

/* ---------- 4. 推送（本机网络不稳，失败重试 3 次） ---------- */

step('推送到 GitHub');
let pushed = false;
for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = run('git', ['push'], { capture: true, allowFail: true });
    if (result.status === 0) {
        pushed = true;
        break;
    }
    const reason = String(result.stderr || result.stdout || '').trim().split('\n').pop();
    console.log(`第 ${attempt} 次失败：${reason}`);
    if (attempt < 3) sleep(5000);
}

if (!pushed) {
    console.error('\n推送失败。网络问题而已，稍后重跑 `git push` 或再执行一次本命令即可；本地改动都在。');
    process.exit(1);
}

console.log('\n已推送。GitHub Actions 会自动构建并部署，通常 40~90 秒后生效：');
console.log('  https://themarter.github.io/album/');
