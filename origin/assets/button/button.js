/* ============================================================
   首页 · 公共按钮

   需求：按一下 = 按下（并一直保持着），再按一下 = 弹起；
   而且这个「按着」的状态要留给下一个打开页面的人。

   纯静态站自己存不住东西，所以状态丢给 ntfy.sh 的一个公开频道：
     - 写：POST /<topic>   body = "press|down|12"
     - 读：GET  /<topic>/json?poll=1&since=all  （返回缓存里的全部消息，取最后一条）
     - 实时：GET /<topic>/sse  别的标签页/别人一按，这边立刻跟着动
   频道是公开的，消息缓存 12 小时，所以 12 小时没人来看它就会自己弹回去。
   连不上频道时退回 localStorage，至少「自己下次来」还是按着的。
   ============================================================ */

(function () {
    'use strict';

    const TOPIC = 'marter-space-shared-button-2f7c';
    const BASE = 'https://ntfy.sh/' + TOPIC;
    const LOCAL_KEY = 'pb.state';
    const POLL_MS = 30000;       // 兜底轮询，SSE 正常时也留着，成本可以忽略
    const HEARTBEAT_AFTER = 6 * 3600 * 1000;   // 状态快过期时补发一次，续 12 小时
    const TIMEOUT_MS = 8000;

    const root = document.querySelector('.pb');
    const btn = document.getElementById('pb-btn');
    const btnText = document.getElementById('pb-btn-text');
    const stateEl = document.getElementById('pb-state');
    const countEl = document.getElementById('pb-count');
    const timeEl = document.getElementById('pb-time');
    const footEl = document.getElementById('pb-foot');

    if (!root || !btn) return;

    /** @type {{down: boolean, n: number, t: number}} */
    let state = { down: false, n: 0, t: 0 };
    let pending = false;
    let es = null;

    /* ---------------- 渲染 ---------------- */

    function apply(next) {
        state = next;
        root.classList.toggle('is-down', next.down);
        btn.setAttribute('aria-pressed', next.down ? 'true' : 'false');
        btnText.textContent = next.down ? '弹起来' : '按下去';
        stateEl.textContent = next.down ? '按下中' : '弹起';
        countEl.textContent = next.n > 0 ? '共被按过 ' + next.n + ' 次' : '还没被按过';
        renderTime();
    }

    function renderTime() {
        if (!state.t) {
            timeEl.textContent = '等第一个人';
            return;
        }
        timeEl.textContent = relTime(state.t) + '有人' + (state.down ? '按下' : '弹起');
    }

    function relTime(ms) {
        const d = Math.max(0, (Date.now() - ms) / 1000);
        if (d < 45) return '刚刚';
        if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
        if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
        return Math.floor(d / 86400) + ' 天前';
    }

    /* 首屏那几百毫秒还没问到远端，先把读数压暗，别让人看到假的「弹起」 */
    function startLoading() {
        root.classList.add('is-loading');
        btn.disabled = true;
        if (!state.t) {
            stateEl.textContent = '同步中';
            countEl.textContent = '—';
            timeEl.textContent = '稍等';
        }
    }

    function endLoading() {
        if (!root.classList.contains('is-loading')) return;
        root.classList.remove('is-loading');
        btn.disabled = false;
        if (!state.t) {
            stateEl.textContent = state.down ? '按下中' : '弹起';
            countEl.textContent = '还没被按过';
            timeEl.textContent = '等第一个人';
        }
        renderTime();
    }

    function setOffline(off) {
        root.classList.toggle('is-offline', off);
        footEl.textContent = off
            ? '连不上共享频道，这一次只记在你这台机器的浏览器里。'
            : '状态存在 ntfy.sh 的一个公开频道上，12 小时没人动它就会自己弹回去。';
    }

    /* ---------------- 本地缓存 ---------------- */

    function saveLocal(s) {
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(s));
        } catch (e) { /* 隐私模式下写不进去，不影响使用 */ }
    }

    function loadLocal() {
        try {
            const raw = localStorage.getItem(LOCAL_KEY);
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (typeof s.down !== 'boolean') return null;
            return { down: s.down, n: Number(s.n) || 0, t: Number(s.t) || 0 };
        } catch (e) {
            return null;
        }
    }

    /* ---------------- 远端读写 ---------------- */

    function parseMsg(obj) {
        if (!obj || obj.event !== 'message' || typeof obj.message !== 'string') return null;
        const parts = obj.message.split('|');
        if (parts[0] !== 'press') return null;
        return {
            down: parts[1] === 'down',
            n: parseInt(parts[2], 10) || 0,
            t: (Number(obj.time) || 0) * 1000
        };
    }

    function ctrl() {
        if (typeof AbortController === 'undefined') return undefined;
        const c = new AbortController();
        setTimeout(function () { c.abort(); }, TIMEOUT_MS);
        return c.signal;
    }

    async function fetchState() {
        const res = await fetch(BASE + '/json?poll=1&since=all', {
            cache: 'no-store',
            signal: ctrl()
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        let last = null;
        text.split('\n').forEach(function (line) {
            if (!line.trim()) return;
            try {
                const s = parseMsg(JSON.parse(line));
                if (s) last = s;
            } catch (e) { /* 半行/心跳，跳过 */ }
        });
        return last;
    }

    async function publish(s) {
        const res = await fetch(BASE, {
            method: 'POST',
            body: 'press|' + (s.down ? 'down' : 'up') + '|' + s.n,
            signal: ctrl()
        });
        return res.ok;
    }

    /* ---------------- 交互 ---------------- */

    async function press() {
        if (pending) return;
        pending = true;

        const next = { down: !state.down, n: state.n + 1, t: Date.now() };
        apply(next);          // 先动，别等网络
        saveLocal(next);

        try {
            await publish(next);
            setOffline(false);
        } catch (e) {
            setOffline(true);
            pending = false;
            return;
        }
        pending = false;

        // 以服务器上的顺序为准：万一两个人同时按，这里会把结果拉平
        setTimeout(function () {
            fetchState().then(function (s) {
                if (s) {
                    apply(s);
                    saveLocal(s);
                }
            }).catch(function () { /* 忽略 */ });
        }, 700);
    }

    btn.addEventListener('click', press);

    /* ---------------- 启动 ---------------- */

    const local = loadLocal();
    if (local) apply(local);
    else apply(state);

    startLoading();
    // 网络太差时别把按钮按死，4 秒后无论如何放开
    setTimeout(endLoading, 4000);

    (async function boot() {
        let remote = null;
        try {
            remote = await fetchState();
            if (remote) {
                apply(remote);
                saveLocal(remote);
            }
            setOffline(false);
        } catch (e) {
            setOffline(true);
        } finally {
            endLoading();
        }

        // 没人按过时远端是空的，什么都不用做；
        // 有状态且快到 12 小时了，就补发一次，别让它在没人来的时候悄悄过期
        if (remote && Date.now() - remote.t > HEARTBEAT_AFTER) {
            publish(remote).catch(function () { /* 忽略 */ });
        }
    })();

    // 实时：别人一按，这边跟着动
    try {
        es = new EventSource(BASE + '/sse');
        es.onmessage = function (ev) {
            try {
                const s = parseMsg(JSON.parse(ev.data));
                if (s) {
                    apply(s);
                    saveLocal(s);
                    setOffline(false);
                }
            } catch (e) { /* 心跳 */ }
        };
    } catch (e) { /* 不支持就算了，还有轮询 */ }

    setInterval(function () {
        fetchState().then(function (s) {
            if (s && (s.t !== state.t || s.down !== state.down)) {
                apply(s);
                saveLocal(s);
            }
            setOffline(false);
        }).catch(function () { /* 网络抖一下不提示，别吓人 */ });
    }, POLL_MS);

    setInterval(renderTime, 15000);

    // 从别的标签页切回来，立刻对一次
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            fetchState().then(function (s) {
                if (s && (s.t !== state.t || s.down !== state.down)) {
                    apply(s);
                    saveLocal(s);
                }
            }).catch(function () { /* 忽略 */ });
        }
    });
})();
