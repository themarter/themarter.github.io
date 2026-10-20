/*!
 * 特蕾西娅看板娘 —— 右下角的小挂件
 *
 * 模型：明日方舟 enemy_1554_lrtsia（Spine 3.8，来自 Ark-Models）
 * 运行时：spine-webgl 3.8（官方）
 *
 * 交互：
 *   - 拖动：移动位置（位置记在 localStorage）
 *   - 单击：换一个动作
 *   - 双击：归位到右下角
 *   - 右上角 ×：本次会话内隐藏
 */
(function () {
    'use strict';

    var CONFIG = {
        base: '/assets/spine/theresa/',
        atlas: 'enemy_1554_lrtsia.atlas',
        skel: 'enemy_1554_lrtsia.skel',
        texture: 'enemy_1554_lrtsia.png',
        idle: 'C1_Idle',
        actions: ['C1_Skill_3', 'C1_Skill_4', 'C3_Attack'],
        storageKey: 'theresa-widget-pos',
        sessionKey: 'theresa-widget-hidden',
        minViewport: 480,
    };

    // 小屏不加载（也省掉 470KB 的模型请求）
    if (window.innerWidth < CONFIG.minViewport) return;
    try {
        if (sessionStorage.getItem(CONFIG.sessionKey) === '1') return;
    } catch (e) {}

    var root = document.createElement('div');
    root.className = 'theresa-widget';
    root.innerHTML =
        '<canvas aria-hidden="true"></canvas>' +
        '<button type="button" class="theresa-widget__close" aria-label="关闭看板娘" title="关闭">×</button>';
    document.body.appendChild(root);

    var canvas = root.querySelector('canvas');
    var gl =
        canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false }) ||
        canvas.getContext('experimental-webgl', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: true,
            depth: false,
        });

    if (!gl) {
        root.remove();
        return;
    }

    var renderer = null;
    var skeleton = null;
    var state = null;
    var camera = null;
    var bounds = null;
    var actionIndex = 0;
    var rafId = 0;
    var lastTime = 0;

    /* ---------------- 位置与拖动 ---------------- */

    function clampPosition(left, top) {
        var w = root.offsetWidth;
        var h = root.offsetHeight;
        var maxLeft = Math.max(0, window.innerWidth - w);
        var maxTop = Math.max(0, window.innerHeight - h);
        return {
            left: Math.min(Math.max(0, left), maxLeft),
            top: Math.min(Math.max(0, top), maxTop),
        };
    }

    function applyPosition(left, top, persist) {
        var pos = clampPosition(left, top);
        root.style.left = pos.left + 'px';
        root.style.top = pos.top + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        if (persist) {
            try {
                localStorage.setItem(CONFIG.storageKey, JSON.stringify(pos));
            } catch (e) {}
        }
    }

    function restorePosition() {
        try {
            var saved = JSON.parse(localStorage.getItem(CONFIG.storageKey) || 'null');
            if (saved && typeof saved.left === 'number') {
                applyPosition(saved.left, saved.top, false);
                return true;
            }
        } catch (e) {}
        return false;
    }

    function resetPosition() {
        try {
            localStorage.removeItem(CONFIG.storageKey);
        } catch (e) {}
        root.style.left = '';
        root.style.top = '';
        root.style.right = '';
        root.style.bottom = '';
        fitCamera();
    }

    var drag = { active: false, moved: false, startX: 0, startY: 0, originLeft: 0, originTop: 0 };
    var clickTimer = null;

    root.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.theresa-widget__close')) return;
        if (typeof e.button === 'number' && e.button !== 0) return;

        var rect = root.getBoundingClientRect();
        drag.active = true;
        drag.moved = false;
        drag.startX = e.clientX;
        drag.startY = e.clientY;
        drag.originLeft = rect.left;
        drag.originTop = rect.top;
        root.classList.add('is-dragging');
        try {
            root.setPointerCapture(e.pointerId);
        } catch (err) {}
    });

    root.addEventListener('pointermove', function (e) {
        if (!drag.active) return;
        var dx = e.clientX - drag.startX;
        var dy = e.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
        drag.moved = true;
        applyPosition(drag.originLeft + dx, drag.originTop + dy, false);
    });

    root.addEventListener('pointerup', function (e) {
        if (!drag.active) return;
        drag.active = false;
        root.classList.remove('is-dragging');
        try {
            if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
        } catch (err) {}

        if (drag.moved) {
            var rect = root.getBoundingClientRect();
            applyPosition(rect.left, rect.top, true);
            return;
        }

        // 单击换动作，双击归位（220ms 内第二次点击即视为双击）
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
            resetPosition();
        } else {
            clickTimer = setTimeout(function () {
                clickTimer = null;
                playNextAction();
            }, 220);
        }
    });

    root.querySelector('.theresa-widget__close').addEventListener('click', function () {
        try {
            sessionStorage.setItem(CONFIG.sessionKey, '1');
        } catch (e) {}
        cancelAnimationFrame(rafId);
        root.remove();
    });

    /* ---------------- 渲染 ---------------- */

    function computeBounds() {
        skeleton.setToSetupPose();
        skeleton.updateWorldTransform();
        var offset = new spine.Vector2();
        var size = new spine.Vector2();
        skeleton.getBounds(offset, size, []);
        if (!(size.x > 0) || !(size.y > 0)) {
            size.x = 200;
            size.y = 400;
            offset.x = -100;
            offset.y = 0;
        }
        return { cx: offset.x + size.x / 2, cy: offset.y + size.y / 2, size: size };
    }

    function fitCamera() {
        if (!renderer || !canvas) return;
        var rect = root.getBoundingClientRect();
        var width = Math.max(1, Math.round(rect.width));
        var height = Math.max(1, Math.round(rect.height));
        var dpr = Math.min(window.devicePixelRatio || 1, 2);

        renderer.resize(Math.round(width * dpr), Math.round(height * dpr));

        var pad = 1.08;
        var bw = bounds.size.x * pad;
        var bh = bounds.size.y * pad;
        var aspect = width / height;

        if (bw / bh > aspect) {
            camera.viewportWidth = bw;
            camera.viewportHeight = bw / aspect;
        } else {
            camera.viewportHeight = bh;
            camera.viewportWidth = bh * aspect;
        }
        camera.position.set(bounds.cx, bounds.cy, 0);
        camera.update();
    }

    function playNextAction() {
        if (!state) return;
        var name = CONFIG.actions[actionIndex % CONFIG.actions.length];
        actionIndex += 1;
        if (!state.setAnimation(0, name, false)) return;
        state.addAnimation(0, CONFIG.idle, true, 0.15);
    }

    function frame(now) {
        rafId = requestAnimationFrame(frame);
        if (document.hidden) {
            lastTime = now;
            return;
        }
        var delta = Math.min((now - lastTime) / 1000, 0.05);
        lastTime = now;

        skeleton.update(delta);
        state.update(delta);
        state.apply(skeleton);
        skeleton.updateWorldTransform();

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.begin();
        renderer.drawSkeleton(skeleton, true); // 纹理为预乘 Alpha
        renderer.end();
    }

    function loadTexture(url) {
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                resolve(img);
            };
            img.onerror = function () {
                resolve(null);
            };
            img.src = url;
        });
    }

    function init() {
        if (typeof spine === 'undefined' || !spine.webgl) return;

        renderer = new spine.webgl.SceneRenderer(canvas, gl);
        camera = renderer.camera;

        Promise.all([
            fetch(CONFIG.base + CONFIG.atlas).then(function (r) {
                return r.text();
            }),
            fetch(CONFIG.base + CONFIG.skel).then(function (r) {
                return r.arrayBuffer();
            }),
            loadTexture(CONFIG.base + CONFIG.texture),
        ])
            .then(function (results) {
                var atlasText = results[0].replace(/^\uFEFF/, '');
                var skelBuffer = results[1];
                var image = results[2];
                if (!image) throw new Error('纹理加载失败');

                var texture = new spine.webgl.GLTexture(gl, image, false);
                var atlas = new spine.TextureAtlas(atlasText, function () {
                    return texture;
                });
                var attachmentLoader = new spine.AtlasAttachmentLoader(atlas);
                var skeletonData = new spine.SkeletonBinary(attachmentLoader).readSkeletonData(
                    new Uint8Array(skelBuffer),
                );

                skeleton = new spine.Skeleton(skeletonData);
                skeleton.setToSetupPose();

                state = new spine.AnimationState(new spine.AnimationStateData(skeletonData));
                var idleName = skeletonData.findAnimation(CONFIG.idle)
                    ? CONFIG.idle
                    : skeletonData.animations.length
                      ? skeletonData.animations[0].name
                      : null;
                if (idleName) {
                    CONFIG.idle = idleName;
                    state.setAnimation(0, idleName, true);
                }

                bounds = computeBounds();
                restorePosition();
                fitCamera();

                lastTime = performance.now();
                rafId = requestAnimationFrame(frame);

                var resizeTimer = 0;
                window.addEventListener('resize', function () {
                    clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(function () {
                        var current = localStorage.getItem(CONFIG.storageKey);
                        if (current) {
                            var pos = root.getBoundingClientRect();
                            applyPosition(pos.left, pos.top, false);
                        }
                        fitCamera();
                    }, 150);
                });
            })
            .catch(function (err) {
                console.warn('[theresa-widget] 初始化失败：', err);
                root.remove();
            });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
