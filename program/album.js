#!/usr/bin/env node
/**
 * 相册加密工具
 *
 * 静态站点没有服务端，所以"密码"不能只在页面里判断——那样直接访问图片地址就绕过了。
 * 做法：用密码派生密钥（PBKDF2-SHA256），把照片用 AES-256-GCM 加密后放进
 * origin/assets/album/，浏览器里输入正确密码才解得出明文。密码本身不落盘。
 *
 * 用法：
 *   ALBUM_PASSWORD=你的密码 node program/album.js ./photos
 *   ALBUM_PASSWORD=你的密码 node program/album.js ./photos --clear   # 清空相册
 *
 * 每张照片会生成两版：正片（长边 2000）和缩略图（长边 480），都加密。
 * 原图不会进仓库（photos/ 已在 .gitignore 里忽略）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'origin', 'assets', 'album');
const ITERATIONS = 250000;
const FULL_EDGE = 2000;
const THUMB_EDGE = 480;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);

/* ---------- 参数 ---------- */

function parseArgs(argv) {
    const args = { dir: path.join(ROOT, 'photos'), password: process.env.ALBUM_PASSWORD || '', clear: false };
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (item === '--clear') args.clear = true;
        else if (item === '--password' || item === '-p') args.password = argv[++i] || '';
        else if (!item.startsWith('-')) args.dir = path.resolve(item);
    }
    return args;
}

/* ---------- ffmpeg ---------- */

function findFfmpeg() {
    const candidates = [
        process.env.FFMPEG,
        'C:/Users/11695/.workbuddy/binaries/python/envs/default/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
        'ffmpeg',
    ].filter(Boolean);
    for (const bin of candidates) {
        try {
            execFileSync(bin, ['-version'], { stdio: 'ignore' });
            return bin;
        } catch (err) {
            /* 试下一个 */
        }
    }
    return null;
}

/** 缩放并转成 JPEG（同时清掉 EXIF，避免把 GPS 位置带出去） */
function transcode(ffmpeg, src, edge, quality) {
    const tmp = path.join(os.tmpdir(), `album-${crypto.randomBytes(6).toString('hex')}.jpg`);
    const filter =
        `scale=w='if(gte(iw,ih),min(${edge},iw),-2)':h='if(gte(iw,ih),-2,min(${edge},ih))':flags=lanczos`;
    try {
        execFileSync(
            ffmpeg,
            ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map_metadata', '-1',
                '-vf', filter, '-q:v', String(quality), '-pix_fmt', 'yuvj420p', tmp],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const buf = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        return buf;
    } catch (err) {
        try {
            fs.existsSync(tmp) && fs.unlinkSync(tmp);
        } catch (e) {
            /* 忽略 */
        }
        throw new Error(`转码失败：${path.basename(src)}（${String(err.stderr || err.message).split('\n')[0]}）`);
    }
}

/* ---------- 读 JPEG 尺寸（决定前端占位比例，免得图片出现时版面跳） ---------- */

function jpegSize(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i < buf.length - 1) {
        if (buf[i] !== 0xff) {
            i += 1;
            continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        if (marker === 0xd9 || marker === 0xda) break;
        const len = buf.readUInt16BE(i + 2);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF && i + 9 < buf.length) {
            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

/* ---------- 加密 ---------- */

function makeCipher(key) {
    return function encrypt(buffer) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
        return { iv, data: Buffer.concat([body, cipher.getAuthTag()]) };
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    if (!args.password) {
        console.error('[album] 缺少密码。用 ALBUM_PASSWORD=xxx node program/album.js ./photos');
        process.exit(1);
    }

    // --clear：清空照片，但保留一册"空相册"（页面显示空状态，而不是报错）
    if (args.clear) {
        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(args.password, salt, ITERATIONS, 32, 'sha256');
        const encrypt = makeCipher(key);
        const metaEnc = encrypt(Buffer.from('[]', 'utf8'));

        fs.writeFileSync(path.join(OUT_DIR, 'meta.bin'), metaEnc.data);
        fs.writeFileSync(
            path.join(OUT_DIR, 'manifest.json'),
            JSON.stringify(
                {
                    v: 1,
                    kdf: { algo: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: salt.toString('base64') },
                    meta: { file: 'meta.bin', iv: metaEnc.iv.toString('base64') },
                    items: [],
                },
                null,
                2,
            ) + '\n',
        );
        for (const file of fs.readdirSync(OUT_DIR)) {
            if (/^t?p\d+\.bin$/i.test(file)) fs.unlinkSync(path.join(OUT_DIR, file));
        }
        console.log('[album] 已清空：保留空相册');
        return;
    }

    if (!fs.existsSync(args.dir)) {
        fs.mkdirSync(args.dir, { recursive: true });
        console.error(`[album] 目录不存在，已创建：${args.dir}\n把照片放进去再跑一次。`);
        process.exit(1);
    }

    const files = fs
        .readdirSync(args.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    if (files.length === 0) {
        console.error(`[album] ${args.dir} 里没有找到图片`);
        process.exit(1);
    }

    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
        console.error('[album] 找不到 ffmpeg，可以设 FFMPEG 环境变量指向可执行文件');
        process.exit(1);
    }

    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(args.password, salt, ITERATIONS, 32, 'sha256');
    const encrypt = makeCipher(key);

    const items = [];
    const meta = [];
    const keep = new Set();

    files.forEach((name, index) => {
        const src = path.join(args.dir, name);
        const id = 'p' + String(index + 1).padStart(3, '0');

        const fullJpg = transcode(ffmpeg, src, FULL_EDGE, 3);
        const size = jpegSize(fullJpg) || { w: 0, h: 0 };
        const full = encrypt(fullJpg);
        const thumb = encrypt(transcode(ffmpeg, src, THUMB_EDGE, 5));

        fs.writeFileSync(path.join(OUT_DIR, `${id}.bin`), full.data);
        fs.writeFileSync(path.join(OUT_DIR, `t${id}.bin`), thumb.data);
        keep.add(`${id}.bin`);
        keep.add(`t${id}.bin`);

        items.push({
            id,
            w: size.w,
            h: size.h,
            full: `${id}.bin`,
            fullIv: full.iv.toString('base64'),
            thumb: `t${id}.bin`,
            thumbIv: thumb.iv.toString('base64'),
        });
        meta.push({ id, name: path.parse(name).name });

        console.log(
            `[album] ${id} ← ${name}  ${size.w}×${size.h}  (${Math.round(full.data.length / 1024)}KB + ${Math.round(thumb.data.length / 1024)}KB)`,
        );
    });

    const metaEnc = encrypt(Buffer.from(JSON.stringify(meta), 'utf8'));
    fs.writeFileSync(path.join(OUT_DIR, 'meta.bin'), metaEnc.data);
    keep.add('meta.bin');

    fs.writeFileSync(
        path.join(OUT_DIR, 'manifest.json'),
        JSON.stringify(
            {
                v: 1,
                kdf: { algo: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: salt.toString('base64') },
                meta: { file: 'meta.bin', iv: metaEnc.iv.toString('base64') },
                items,
            },
            null,
            2,
        ) + '\n',
    );
    keep.add('manifest.json');

    // 清掉上一次留下、这次没生成的密文
    for (const file of fs.readdirSync(OUT_DIR)) {
        if (!keep.has(file) && /\.(bin|json)$/i.test(file)) {
            fs.unlinkSync(path.join(OUT_DIR, file));
            console.log(`[album] 移除旧文件 ${file}`);
        }
    }

    console.log(`[album] 完成：${items.length} 张照片，输出在 origin/assets/album/`);
}

main();
