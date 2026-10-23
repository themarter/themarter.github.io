/* ============================================================
   /album 相册前端（公开相册，无密码）
   - 清单由构建时的 program/build.js 生成：/album/manifest.json
   - 瀑布流：按图片比例算 grid 行跨度，图未加载时不会跳版
   - 大图：键盘 ←/→/Esc、手机左右滑动
   ============================================================ */
(function () {
    'use strict';

    var root = document.querySelector('.album');
    if (!root) return;

    var MANIFEST = '/album/manifest.json';

    var grid = root.querySelector('.album__grid');
    var countEl = root.querySelector('.album__count');
    var emptyEl = root.querySelector('.album__empty');
    var lightbox = root.querySelector('.album__lightbox');
    var photoEl = root.querySelector('.album__photo');
    var captionEl = root.querySelector('.album__caption');
    var prevBtn = root.querySelector('.album__nav--prev');
    var nextBtn = root.querySelector('.album__nav--next');
    var closeBtn = root.querySelector('.album__close');

    var state = { photos: [], current: -1 };

    /* ---------- 渲染 ---------- */

    function renderGrid() {
        grid.innerHTML = '';
        countEl.textContent = state.photos.length ? state.photos.length + ' 张' : '';

        if (!state.photos.length) {
            emptyEl.hidden = false;
            return;
        }
        emptyEl.hidden = true;

        state.photos.forEach(function (photo, index) {
            var fig = document.createElement('figure');
            fig.className = 'album__item is-pending';
            fig.dataset.index = String(index);

            var ar = photo.w && photo.h ? photo.w / photo.h : 1.5;
            fig.dataset.ar = String(ar);
            fig.style.aspectRatio = photo.w && photo.h ? photo.w + ' / ' + photo.h : '3 / 2';

            fig.setAttribute('role', 'button');
            fig.setAttribute('tabindex', '0');
            fig.setAttribute('aria-label', '查看第 ' + (index + 1) + ' 张');

            var img = new Image();
            img.alt = photo.title || '照片';
            img.decoding = 'async';
            img.loading = 'lazy';
            img.addEventListener('load', function () {
                fig.classList.remove('is-pending');
                img.classList.add('is-ready');
            });
            img.addEventListener('error', function () {
                fig.classList.remove('is-pending');
                fig.classList.add('is-broken');
            });
            img.src = photo.src;
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
        });

        layoutGrid();
    }

    /* 按列宽和图片比例算每格占几行（grid-auto-rows 是细轨，这样才是真瀑布流） */
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
    }

    function showPhoto(index) {
        var photo = state.photos[index];
        if (!photo) return;
        captionEl.textContent = photo.title || '';
        photoEl.alt = photo.title || '照片';
        prevBtn.disabled = index === 0;
        nextBtn.disabled = index === state.photos.length - 1;
        photoEl.src = photo.src;
    }

    function step(delta) {
        var next = state.current + delta;
        if (next < 0 || next >= state.photos.length) return;
        state.current = next;
        showPhoto(next);
    }

    /* ---------- 事件 ---------- */

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
        lightbox.addEventListener(
            'touchstart',
            function (event) {
                startX = event.touches[0].clientX;
                startY = event.touches[0].clientY;
            },
            { passive: true },
        );
        lightbox.addEventListener(
            'touchend',
            function (event) {
                var dx = event.changedTouches[0].clientX - startX;
                var dy = event.changedTouches[0].clientY - startY;
                if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
                step(dx < 0 ? 1 : -1);
            },
            { passive: true },
        );
    })();

    /* ---------- 取清单 ---------- */

    fetch(MANIFEST, { cache: 'no-cache' })
        .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function (data) {
            state.photos = (data && data.photos) || [];
            renderGrid();
        })
        .catch(function () {
            emptyEl.hidden = false;
            emptyEl.textContent = '相册清单没找到。确认 origin/album/photos/ 里有图片，然后重新构建。';
        });
})();
