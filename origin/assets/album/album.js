/* ============================================================
   /album 相册前端
   - 密码经 PBKDF2 派生成密钥，在浏览器里解 AES-256-GCM 密文
   - 缩略图滚动到视口才解密；点开才解密正片
   - 解锁后密钥存在 sessionStorage，刷新这个标签页不用重输
   ============================================================ */
(function () {
    'use strict';

    var root = document.querySelector('.album');
    if (!root) return;

    var BASE = '/assets/album/';
    var STORE_KEY = 'album-key';
    var CONCURRENCY = 4;

    var gate = root.querySelector('.album__gate');
    var input = root.querySelector('.album__input');
    var submit = root.querySelector('.album__submit');
    var errorEl = root.querySelector('.album__error');
    var view = root.querySelector('.album__view');
    var grid = root.querySelector('.album__grid');
    var countEl = root.querySelector('.album__count');
    var emptyEl = root.querySelector('.album__empty');
    var lockBtn = root.querySelector('.album__lock');
    var lightbox = root.querySelector('.album__lightbox');
    var photoEl = root.querySelector('.album__photo');
    var captionEl = root.querySelector('.album__caption');
    var prevBtn = root.querySelector('.album__nav--prev');
    var nextBtn = root.querySelector('.album__nav--next');
    var closeBtn = root.querySelector('.album__close');

    var state = {
        manifest: null,
        key: null,
        meta: {},
        items: [],
        current: -1,
        token: 0,
        full: {},
        urls: [],
    };

    if (!window.crypto || !window.crypto.subtle) {
        errorEl.textContent = '这个浏览器不支持网页解密，换 Chrome / Edge / Safari 的较新版本试试。';
        submit.disabled = true;
        return;
    }

    /* ---------- 小工具 ---------- */

    function fromB64(text) {
        var bin = atob(text);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
    }

    function toB64(bytes) {
        var text = '';
        for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
        return btoa(text);
    }

    async function fetchBuf(url) {
        var res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
        return res.arrayBuffer();
    }

    async function deriveRaw(password, kdf) {
        var base = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveBits'],
        );
        var bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: fromB64(kdf.salt), iterations: kdf.iterations, hash: kdf.hash },
            base,
            256,
        );
        return new Uint8Array(bits);
    }

    function importKey(raw) {
        return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    }

    function decryptBytes(key, ivB64, buffer) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, key, buffer);
    }

    function makeLimiter(limit) {
        var queue = [];
        var active = 0;
        function next() {
            while (active < limit && queue.length) {
                var job = queue.shift();
                active += 1;
                job().then(function () {
                    active -= 1;
                    next();
                });
            }
        }
        return function (job) {
            return new Promise(function (resolve, reject) {
                queue.push(function () {
                    return job().then(resolve, reject);
                });
                next();
            });
        };
    }

    var limit = makeLimiter(CONCURRENCY);

    function trackUrl(url) {
        state.urls.push(url);
        return url;
    }

    /* ---------- 解锁 ---------- */

    async function unlock(password) {
        var manifest = state.manifest || (await fetchJson(BASE + 'manifest.json'));
        if (!manifest || !manifest.items) throw new Error('相册还没生成');

        var raw = await deriveRaw(password, manifest.kdf);
        var key = await importKey(raw);

        var buf = await fetchBuf(BASE + manifest.meta.file);
        var plain;
        try {
            plain = await decryptBytes(key, manifest.meta.iv, buf);
        } catch (err) {
            throw new Error('wrong');
        }

        var list = JSON.parse(new TextDecoder().decode(plain));
        var meta = {};
        list.forEach(function (entry) {
            meta[entry.id] = entry.name;
        });

        return { manifest: manifest, raw: raw, key: key, meta: meta, items: manifest.items };
    }

    async function fetchJson(url) {
        var res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return res.json();
    }

    function applyUnlock(result) {
        state.manifest = result.manifest;
        state.key = result.key;
        state.meta = result.meta;
        state.items = result.items;

        try {
            sessionStorage.setItem(STORE_KEY, toB64(result.raw));
        } catch (err) {
            /* 隐私模式下写不进去，不影响使用 */
        }

        gate.hidden = true;
        view.hidden = false;
        renderGrid();
    }

    /* ---------- 渲染 ---------- */

    function renderGrid() {
        grid.innerHTML = '';
        state.full = {};
        countEl.textContent = state.items.length ? state.items.length + ' 张' : '';

        if (state.items.length === 0) {
            emptyEl.hidden = false;
            return;
        }
        emptyEl.hidden = true;

        var io = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    io.unobserve(entry.target);
                    var fig = entry.target;
                    limit(function () {
                        return loadThumb(Number(fig.dataset.index), fig);
                    });
                });
            },
            { rootMargin: '500px 0px' },
        );

        state.items.forEach(function (item, index) {
            var fig = document.createElement('figure');
            fig.className = 'album__item is-pending';
            fig.dataset.index = String(index);

            /* 先按原始比例占好位置，缩略图解出来时版面不会跳 */
            var ar = item.w && item.h ? item.w / item.h : 1.5;
            fig.dataset.ar = String(ar);
            fig.style.aspectRatio = item.w && item.h ? item.w + ' / ' + item.h : '3 / 2';

            fig.setAttribute('role', 'button');
            fig.setAttribute('tabindex', '0');
            fig.setAttribute('aria-label', '查看第 ' + (index + 1) + ' 张');

            var img = new Image();
            img.alt = state.meta[item.id] || '照片';
            img.decoding = 'async';
            fig.appendChild(img);

            fig.addEventListener('click', function () {
                openLightbox(index);
            });
            fig.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openLightbox(index);
                }
            });

            grid.appendChild(fig);
            io.observe(fig);
        });

        layoutGrid();
    }

    /* 按列宽和图片比例算每格占几行（grid-auto-rows 是细轨，这样才有真瀑布流） */
    var layoutTimer = 0;

    function layoutGrid() {
        var first = grid.firstElementChild;
        if (!first) return;

        var style = getComputedStyle(grid);
        var gap = parseFloat(style.columnGap) || 14;
        var rowH = parseFloat(style.gridAutoRows) || 6;
        var colW = first.getBoundingClientRect().width;
        if (!colW) return;

        Array.prototype.forEach.call(grid.children, function (fig) {
            var ar = parseFloat(fig.dataset.ar) || 1.5;
            var span = Math.max(1, Math.ceil((colW / ar + gap) / (rowH + gap)));
            fig.style.gridRowEnd = 'span ' + span;
        });
    }

    window.addEventListener('resize', function () {
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(layoutGrid, 140);
    });

    async function loadThumb(index, fig) {
        var item = state.items[index];
        var img = fig.querySelector('img');
        try {
            var buf = await fetchBuf(BASE + item.thumb);
            var plain = await decryptBytes(state.key, item.thumbIv, buf);
            var url = trackUrl(URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' })));
            img.addEventListener('load', function () {
                fig.classList.remove('is-pending');
                img.classList.add('is-ready');
            });
            img.src = url;
        } catch (err) {
            fig.classList.remove('is-pending');
            fig.classList.add('is-broken');
        }
    }

    /* ---------- 大图 ---------- */

    function openLightbox(index) {
        state.current = index;
        lightbox.hidden = false;
        document.body.style.overflow = 'hidden';
        showPhoto(index);
        closeBtn.focus();
    }

    function closeLightbox() {
        lightbox.hidden = true;
        document.body.style.overflow = '';
        photoEl.removeAttribute('src');
        state.token += 1;
    }

    async function showPhoto(index) {
        var item = state.items[index];
        var token = (state.token += 1);

        photoEl.style.opacity = '0';
        captionEl.textContent = state.meta[item.id] || '';
        prevBtn.disabled = index === 0;
        nextBtn.disabled = index === state.items.length - 1;

        if (state.full[index]) {
            photoEl.src = state.full[index];
            photoEl.style.opacity = '1';
            return;
        }

        try {
            var buf = await fetchBuf(BASE + item.full);
            var plain = await decryptBytes(state.key, item.fullIv, buf);
            if (token !== state.token) return;
            var url = trackUrl(URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' })));
            state.full[index] = url;
            photoEl.src = url;
            photoEl.style.opacity = '1';
        } catch (err) {
            if (token !== state.token) return;
            captionEl.textContent = '这张解不出来';
        }
    }

    function step(delta) {
        var next = state.current + delta;
        if (next < 0 || next >= state.items.length) return;
        state.current = next;
        showPhoto(next);
    }

    /* ---------- 事件 ---------- */

    gate.addEventListener('submit', async function (event) {
        event.preventDefault();
        var password = input.value;
        if (!password) {
            input.focus();
            return;
        }

        errorEl.textContent = '';
        submit.disabled = true;
        submit.textContent = '解密中';

        try {
            var result = await unlock(password);
            submit.disabled = false;
            submit.textContent = '进入';
            input.value = '';
            applyUnlock(result);
        } catch (err) {
            submit.disabled = false;
            submit.textContent = '进入';
            if (err && err.message === 'wrong') {
                errorEl.textContent = '密码不对。';
                gate.classList.add('is-shaking');
                setTimeout(function () {
                    gate.classList.remove('is-shaking');
                }, 400);
            } else {
                errorEl.textContent = '打不开相册：' + (err && err.message ? err.message : '未知错误');
            }
            input.select();
        }
    });

    lockBtn.addEventListener('click', function () {
        try {
            sessionStorage.removeItem(STORE_KEY);
        } catch (err) {
            /* 忽略 */
        }
        state.urls.forEach(function (url) {
            URL.revokeObjectURL(url);
        });
        window.location.reload();
    });

    prevBtn.addEventListener('click', function () {
        step(-1);
    });

    nextBtn.addEventListener('click', function () {
        step(1);
    });

    closeBtn.addEventListener('click', closeLightbox);

    lightbox.addEventListener('click', function (event) {
        if (event.target === lightbox) closeLightbox();
    });

    document.addEventListener('keydown', function (event) {
        if (lightbox.hidden) return;
        if (event.key === 'Escape') closeLightbox();
        else if (event.key === 'ArrowLeft') step(-1);
        else if (event.key === 'ArrowRight') step(1);
    });

    /* 左右滑动 */
    (function swipe() {
        var startX = 0;
        var startY = 0;
        lightbox.addEventListener('touchstart', function (event) {
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true });
        lightbox.addEventListener('touchend', function (event) {
            var dx = event.changedTouches[0].clientX - startX;
            var dy = event.changedTouches[0].clientY - startY;
            if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
            step(dx < 0 ? 1 : -1);
        }, { passive: true });
    })();

    /* ---------- 恢复上次的解锁状态 ---------- */

    (async function restore() {
        var saved = null;
        try {
            saved = sessionStorage.getItem(STORE_KEY);
        } catch (err) {
            return;
        }
        if (!saved) return;

        try {
            var manifest = await fetchJson(BASE + 'manifest.json');
            if (!manifest || !manifest.items) return;
            var raw = fromB64(saved);
            var key = await importKey(raw);
            var buf = await fetchBuf(BASE + manifest.meta.file);
            var plain = await decryptBytes(key, manifest.meta.iv, buf);
            var list = JSON.parse(new TextDecoder().decode(plain));
            var meta = {};
            list.forEach(function (entry) {
                meta[entry.id] = entry.name;
            });
            applyUnlock({ manifest: manifest, raw: raw, key: key, meta: meta, items: manifest.items });
        } catch (err) {
            try {
                sessionStorage.removeItem(STORE_KEY);
            } catch (e) {
                /* 忽略 */
            }
        }
    })();
})();
