#!/usr/bin/env node
/**
 * 读图片尺寸（不依赖任何第三方库）
 *
 * 用途：构建相册时得到每张图的宽高，前端按比例给每格定位，
 * 图片加载时版面不会跳。支持的格式：JPEG / PNG / GIF / WebP。
 * 认不出来的返回 null，前端会退回 3:2 的占位比例。
 */

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

function pngSize(buf) {
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function gifSize(buf) {
    if (buf.length < 10) return null;
    if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function webpSize(buf) {
    if (buf.length < 30) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;

    const kind = buf.toString('ascii', 12, 16);

    // 扩展格式：24 bit 的 canvas 宽高减一
    if (kind === 'VP8X') {
        return {
            w: buf.readUIntLE(24, 3) + 1,
            h: buf.readUIntLE(27, 3) + 1,
        };
    }

    // 有损：帧头 3 字节起始码之后是两个 14 bit 的宽高
    if (kind === 'VP8 ') {
        const start = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
        if (start < 0 || start + 7 > buf.length) return null;
        return {
            w: buf.readUInt16LE(start + 3) & 0x3fff,
            h: buf.readUInt16LE(start + 5) & 0x3fff,
        };
    }

    // 无损：0x2f 之后是 14+14 bit 的宽高减一
    if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return {
            w: (bits & 0x3fff) + 1,
            h: ((bits >> 14) & 0x3fff) + 1,
        };
    }

    return null;
}

function imageSize(buf) {
    if (!buf || buf.length < 16) return null;
    return jpegSize(buf) || pngSize(buf) || gifSize(buf) || webpSize(buf) || null;
}

module.exports = { imageSize };
