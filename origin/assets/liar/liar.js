/* ============================================================
   /liar 背景乐控制器
   - 进场先尝试自动播放；被浏览器拦下时提示用户点一下
   - 进度条、音量记忆、空格键播放/暂停
   ============================================================ */
(function () {
    'use strict';

    var root = document.querySelector('.liar');
    if (!root) return;

    var audio = root.querySelector('.liar__audio');
    var toggle = root.querySelector('.liar__toggle');
    var mute = root.querySelector('.liar__mute');
    var bar = root.querySelector('.liar__progress');
    var nowEl = root.querySelector('.liar__now');
    var totalEl = root.querySelector('.liar__total');
    var hint = root.querySelector('.liar__hint');
    if (!audio || !toggle || !bar) return;

    var STORE_KEY = 'liar-bgm';
    var state = { volume: 0.65, muted: false };
    var seeking = false;
    var hintTimer = 0;

    /* ---------- 记忆音量 ---------- */
    try {
        var saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        if (typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1) {
            state.volume = saved.volume;
        }
        state.muted = !!saved.muted;
    } catch (err) {
        /* localStorage 不可用时用默认值 */
    }

    function saveState() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
        } catch (err) {
            /* 忽略：隐私模式下写不进去 */
        }
    }

    function applyVolume() {
        audio.volume = state.volume;
        audio.muted = state.muted;
        root.classList.toggle('is-muted', state.muted);
        mute.setAttribute('aria-label', state.muted ? '取消静音' : '静音');
    }

    /* ---------- 时间格式 ---------- */
    function fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '--:--';
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' + s : s);
    }

    function paintProgress() {
        var dur = audio.duration;
        if (!isFinite(dur) || dur <= 0) return;
        var ratio = Math.min(1, Math.max(0, audio.currentTime / dur));
        var pct = (ratio * 100).toFixed(3) + '%';
        bar.style.setProperty('--p', pct);
        if (!seeking) bar.value = String(Math.round(ratio * 1000));
        nowEl.textContent = fmt(audio.currentTime);
        totalEl.textContent = fmt(dur);
        bar.setAttribute('aria-valuetext', fmt(audio.currentTime) + ' / ' + fmt(dur));
    }

    /* ---------- 提示语 ---------- */
    function say(text, autoHide) {
        clearTimeout(hintTimer);
        hint.textContent = text || '';
        if (text && autoHide) {
            hintTimer = window.setTimeout(function () {
                hint.textContent = '';
            }, autoHide);
        }
    }

    /* ---------- 播放 / 暂停 ---------- */
    function setPlaying(isPlaying) {
        root.classList.toggle('is-playing', isPlaying);
        toggle.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
    }

    function play() {
        var result;
        try {
            result = audio.play();
        } catch (err) {
            say('这段音乐没能播放，可能是浏览器不支持。');
            return;
        }
        if (result && typeof result.then === 'function') {
            root.classList.add('is-loading');
            result.then(function () {
                root.classList.remove('is-loading');
                say('');
            }).catch(function (err) {
                root.classList.remove('is-loading');
                setPlaying(false);
                if (err && err.name === 'NotAllowedError') {
                    say('浏览器拦下了自动播放，点一下播放键就好。');
                } else if (err && err.name === 'NotSupportedError') {
                    say('这个浏览器播放不了这段音频。');
                } else {
                    say('加载失败，检查一下网络再试。', 6000);
                }
            });
        }
    }

    function pause() {
        audio.pause();
    }

    toggle.addEventListener('click', function () {
        if (audio.paused) play();
        else pause();
    });

    audio.addEventListener('play', function () {
        setPlaying(true);
        say('');
    });

    audio.addEventListener('pause', function () {
        setPlaying(false);
    });

    audio.addEventListener('loadedmetadata', paintProgress);
    audio.addEventListener('durationchange', paintProgress);
    audio.addEventListener('timeupdate', paintProgress);

    audio.addEventListener('error', function () {
        root.classList.remove('is-loading');
        setPlaying(false);
        say('音频没有加载出来，刷新页面试试。');
    });

    /* 循环播放：某些浏览器 loop 会和 seek 打架，这里兜一层 */
    audio.addEventListener('ended', function () {
        if (!audio.loop) return;
        audio.currentTime = 0;
        play();
    });

    /* ---------- 拖动进度 ---------- */
    function seekToBar() {
        var dur = audio.duration;
        if (!isFinite(dur) || dur <= 0) return;
        audio.currentTime = (Number(bar.value) / 1000) * dur;
        paintProgress();
    }

    bar.addEventListener('input', function () {
        seeking = true;
        var dur = audio.duration;
        if (isFinite(dur) && dur > 0) {
            var ratio = Number(bar.value) / 1000;
            bar.style.setProperty('--p', (ratio * 100).toFixed(3) + '%');
            nowEl.textContent = fmt(ratio * dur);
        }
    });

    bar.addEventListener('change', function () {
        seekToBar();
        seeking = false;
    });

    bar.addEventListener('pointerup', function () {
        if (seeking) {
            seekToBar();
            seeking = false;
        }
    });

    /* 方向键一次跳 5 秒，比默认的 0.19 秒好用 */
    bar.addEventListener('keydown', function (event) {
        var dur = audio.duration;
        if (!isFinite(dur) || dur <= 0) return;

        if (event.key === 'Home') {
            event.preventDefault();
            audio.currentTime = 0;
            paintProgress();
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            audio.currentTime = Math.max(0, dur - 0.5);
            paintProgress();
            return;
        }

        var delta = 0;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = 5;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -5;
        else return;

        event.preventDefault();
        audio.currentTime = Math.min(dur, Math.max(0, audio.currentTime + delta));
        paintProgress();
    });

    /* ---------- 静音 ---------- */
    mute.addEventListener('click', function () {
        state.muted = !state.muted;
        applyVolume();
        saveState();
    });

    /* ---------- 空格键 ---------- */
    document.addEventListener('keydown', function (event) {
        if (event.key !== ' ' && event.code !== 'Space') return;
        var tag = (event.target && event.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || event.target.isContentEditable) return;
        event.preventDefault();
        if (audio.paused) play();
        else pause();
    });

    /* ---------- 初始化 ---------- */
    applyVolume();
    paintProgress();

    /* 注意：这里不要再调 audio.load()。load() 会把播放位置重置为 0，
       如果发生在用户拖过进度条之后，看起来就像"拖了没反应"。
       预加载交给 HTML 上的 preload="auto"。 */

    /* 进场尝试播放（浏览器通常要求先有交互，失败就走提示） */
    play();
})();
