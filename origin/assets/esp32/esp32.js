/* ============================================================
   /esp32 —— 网页这边只做三件事：问、收、发
   结构见 index.html，样式见 esp32.css
   ============================================================ */

(function () {
    'use strict';

    const SCREEN = { short: 128, long: 160 };
    const POLL_MS = 5000;
    const TIMEOUT_MS = 5000;
    const STORE_KEY = 'esp32.base';

    const ui = {
        base: document.getElementById('base'),
        connect: document.getElementById('connect'),
        dropLink: document.getElementById('drop-link'),
        auto: document.getElementById('auto'),
        dot: document.getElementById('dot'),
        hint: document.getElementById('hint'),
        mixed: document.getElementById('mixed'),
        statusAt: document.getElementById('status-at'),
        answers: document.getElementById('answers'),
        log: document.getElementById('log'),
        clearLog: document.getElementById('clear-log'),
        drop: document.getElementById('drop'),
        file: document.getElementById('file'),
        preview: document.getElementById('preview'),
        imgMeta: document.getElementById('img-meta'),
        rot: document.getElementById('rot'),
        fit: document.getElementById('fit'),
        send: document.getElementById('send'),
        bar: document.getElementById('bar'),
        barWrap: document.querySelector('.esp-bar'),
        lat: document.getElementById('lat'),
        latNow: document.getElementById('lat-now'),
        spark: document.getElementById('spark'),
        latIdle: document.getElementById('lat-idle')
    };

    const stat = {
        chip: document.getElementById('s-chip'),
        fw: document.getElementById('s-fw'),
        ssid: document.getElementById('s-ssid'),
        rssi: document.getElementById('s-rssi'),
        ip: document.getElementById('s-ip'),
        heap: document.getElementById('s-heap'),
        frames: document.getElementById('s-frames'),
        up: document.getElementById('s-up')
    };

    const state = {
        base: '',
        connected: false,
        timer: null,
        image: null,
        bytes: null,
        busy: false,
        asked: false
    };

    const latency = { samples: [] };

    const CMD_LABEL = {
        ping: 'PING',
        status: '状态',
        selftest: '自检',
        clear: '清屏',
        reboot: '重启'
    };

    function labelOf(cmd) {
        return CMD_LABEL[cmd] || String(cmd).toUpperCase();
    }

    /* ---------------- 小工具 ---------------- */

    function log(text, tone) {
        const li = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = new Date().toTimeString().slice(0, 8);
        const span = document.createElement('span');
        span.textContent = text;
        li.append(time, span);
        if (tone) li.dataset.tone = tone;
        ui.log.append(li);
        while (ui.log.children.length > 120) ui.log.firstElementChild.remove();
        ui.log.scrollTop = ui.log.scrollHeight;
    }

    function setHint(text, tone) {
        ui.hint.textContent = text;
        if (tone) ui.hint.dataset.tone = tone;
        else delete ui.hint.dataset.tone;
    }

    function setDot(value) {
        ui.dot.dataset.state = value;
    }

    function setStat(node, text) {
        node.textContent = text || '—';
        node.classList.toggle('is-empty', !text);
    }

    /* 每次问询得一个往返时间，画成一根柱子。用对数刻度，
       10 ms 和 100 ms 的差别才看得出来。 */
    function pushLatency(rtt) {
        if (!Number.isFinite(rtt)) return;
        latency.samples.push(rtt);
        while (latency.samples.length > 28) latency.samples.shift();

        ui.lat.hidden = false;
        ui.latIdle.hidden = latency.samples.length >= 5;
        ui.latNow.textContent = rtt + ' ms';

        const span = Math.log10(1 + 300);
        clearChildren(ui.spark);
        latency.samples.forEach(function (value, index) {
            const bar = document.createElement('i');
            const ratio = Math.min(1, Math.log10(1 + Math.max(0, value)) / span);
            bar.style.height = (18 + ratio * 82).toFixed(1) + '%';
            bar.style.opacity = (0.22 + 0.78 * (index + 1) / latency.samples.length).toFixed(2);
            ui.spark.append(bar);
        });
    }

    function resetLatency() {
        latency.samples = [];
        clearChildren(ui.spark);
        ui.lat.hidden = true;
        ui.latIdle.hidden = false;
        ui.latNow.textContent = '—';
    }

    function humanBytes(n) {
        if (!Number.isFinite(n) || n <= 0) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function humanUptime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '—';
        const s = Math.floor(sec);
        if (s < 60) return s + ' 秒';
        if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
        if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
        return Math.floor(s / 86400) + ' 天 ' + Math.floor((s % 86400) / 3600) + ' 小时';
    }

    function signalWord(rssi) {
        if (!Number.isFinite(rssi)) return '';
        if (rssi >= -55) return '强';
        if (rssi >= -67) return '良';
        if (rssi >= -78) return '弱';
        return '很差';
    }

    function normalizeBase(raw) {
        let value = String(raw || '').trim();
        if (!value) return '';
        value = value.replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
        try {
            const url = new URL(value);
            return url.origin;
        } catch (err) {
            return '';
        }
    }

    function clearChildren(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    /* ---------------- 网络 ---------------- */

    async function api(path, options) {
        const opts = options || {};
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || TIMEOUT_MS);
        const started = performance.now();

        try {
            const res = await fetch(state.base + path, {
                method: opts.method || 'GET',
                headers: opts.headers,
                body: opts.body,
                cache: 'no-store',
                mode: 'cors',
                signal: ctrl.signal
            });
            const rtt = Math.round(performance.now() - started);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (err) {
                throw new Error('返回的不是 JSON（' + text.slice(0, 40) + '…）');
            }
            if (data && data.ok === false) throw new Error(data.msg || '设备返回失败');
            return { data: data, rtt: rtt };
        } finally {
            clearTimeout(timer);
        }
    }

    function explain(err) {
        if (err.name === 'AbortError') return '超时，5 秒内没回应';
        if (err instanceof TypeError) {
            if (location.protocol === 'https:' && state.base.startsWith('http://')) {
                return '被浏览器拦了（HTTPS 页面不能请求 HTTP 设备），看左边那段说明';
            }
            return '连不上，地址或 Wi-Fi 可能不对';
        }
        return err.message || String(err);
    }

    /* ---------------- 连接 ---------------- */

    async function connect() {
        const base = normalizeBase(ui.base.value);
        if (!base) {
            setHint('地址填一下，形如 192.168.1.42。', 'bad');
            ui.base.focus();
            return;
        }

        state.base = base;
        ui.base.value = base.replace(/^https?:\/\//, '');
        localStorage.setItem(STORE_KEY, base);

        ui.connect.disabled = true;
        ui.connect.textContent = '连接中…';
        setDot('busy');
        setHint('正在敲它的门…');

        try {
            const ping = await api('/api/ping', { timeout: 4000 });
            state.connected = true;
            setDot('on');
            ui.connect.hidden = true;
            ui.connect.disabled = false;
            ui.dropLink.hidden = false;
            log('已连上 ' + base + '，往返 ' + ping.rtt + ' ms。', 'ok');
            setHint('通了。往返 ' + ping.rtt + ' ms。', 'ok');
            refreshSendState();
            await readStatus(true);
            startPolling();
        } catch (err) {
            state.connected = false;
            setDot('off');
            ui.connect.disabled = false;
            ui.connect.textContent = '连接';
            setHint(explain(err), 'bad');
            log('连接失败：' + explain(err), 'bad');
            refreshSendState();
        }
    }

    function disconnect() {
        stopPolling();
        state.connected = false;
        ui.connect.hidden = false;
        ui.connect.textContent = '连接';
        ui.dropLink.hidden = true;
        setDot('idle');
        setHint('已断开。ESP32 还在那儿跑，随时可以再连。');
        resetLatency();
        log('已断开连接。');
        refreshSendState();
    }

    function startPolling() {
        stopPolling();
        if (!ui.auto.checked) return;
        state.timer = setInterval(function () {
            if (state.busy || !state.connected) return;
            readStatus(false);
        }, POLL_MS);
    }

    function stopPolling() {
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
    }

    async function readStatus(verbose) {
        try {
            const out = await api('/api/status');
            renderStatus(out.data, out.rtt);
            if (!state.connected) {
                state.connected = true;
                setDot('on');
            }
            return out;
        } catch (err) {
            if (verbose) throw err;
            setDot('off');
            ui.statusAt.textContent = '这一轮没问到';
            if (state.connected) {
                log('状态查询失败：' + explain(err), 'bad');
            }
            return null;
        }
    }

    function renderStatus(data, rtt) {
        const d = data || {};
        const wifi = d.wifi || {};
        const heap = d.heap || {};
        const screen = d.screen || {};

        setStat(stat.chip, d.chip || d.device || '');
        setStat(stat.fw, d.fw || '');
        setStat(stat.ssid, wifi.ssid || '');
        setStat(stat.rssi, Number.isFinite(wifi.rssi)
            ? wifi.rssi + ' dBm · ' + signalWord(wifi.rssi)
            : '');
        setStat(stat.ip, wifi.ip || '');
        setStat(stat.heap, Number.isFinite(heap.free) ? humanBytes(heap.free) : '');
        setStat(stat.frames, Number.isFinite(screen.frames) ? String(screen.frames) : '');
        setStat(stat.up, Number.isFinite(d.up) ? humanUptime(d.up) : '');

        ui.statusAt.textContent = '刚刚 · 往返 ' + rtt + ' ms';
        pushLatency(rtt);
        state.asked = true;

        if (Number.isFinite(screen.w) && Number.isFinite(screen.h)) {
            SCREEN.short = Math.min(screen.w, screen.h);
            SCREEN.long = Math.max(screen.w, screen.h);
        }
    }

    /* ---------------- 问询 ---------------- */

    function pushAnswer(label, text, tone) {
        const empty = ui.answers.querySelector('.esp-answers__empty');
        if (empty) empty.remove();

        const li = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = new Date().toTimeString().slice(0, 8);
        const b = document.createElement('b');
        b.textContent = label;
        const span = document.createElement('span');
        span.textContent = text;
        li.append(time, b, span);
        if (tone) li.dataset.tone = tone;

        ui.answers.prepend(li);
        while (ui.answers.children.length > 8) ui.answers.lastElementChild.remove();
    }

    async function pingThree() {
        const samples = [];
        for (let i = 0; i < 3; i++) {
            const out = await api('/api/ping', { timeout: 3000 });
            samples.push(out.rtt);
            pushLatency(out.rtt);
            if (i < 2) await new Promise(function (r) { setTimeout(r, 120); });
        }
        const min = Math.min.apply(null, samples);
        const max = Math.max.apply(null, samples);
        const avg = Math.round(samples.reduce(function (a, b) { return a + b; }, 0) / samples.length);
        pushAnswer('PING', '最小 ' + min + ' / 平均 ' + avg + ' / 最大 ' + max + ' ms', 'ok');
        log('PING ' + samples.join(' / ') + ' ms', 'ok');
    }

    async function command(cmd) {
        const out = await api('/api/cmd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: cmd }),
            timeout: 6000
        });
        const msg = (out.data && out.data.msg) || 'ok';
        pushAnswer(labelOf(cmd), msg + ' · ' + out.rtt + ' ms', 'ok');
        log('指令 ' + labelOf(cmd) + ' → ' + msg + '（' + out.rtt + ' ms）', 'ok');

        if (cmd === 'status') await readStatus(true);
        if (cmd === 'reboot') {
            stopPolling();
            state.connected = false;
            setDot('busy');
            setHint('已经叫它重启了，等 3 秒再点一次「连接」。');
            ui.connect.hidden = false;
            ui.connect.textContent = '连接';
            ui.dropLink.hidden = true;
            refreshSendState();
        }
    }

    async function runAsk(cmd, button) {
        if (!state.connected) {
            pushAnswer(labelOf(cmd), '还没连上，先连接。', 'bad');
            return;
        }
        button.disabled = true;
        try {
            if (cmd === 'ping') await pingThree();
            else await command(cmd);
        } catch (err) {
            pushAnswer(labelOf(cmd), explain(err), 'bad');
            log('指令失败：' + explain(err), 'bad');
        } finally {
            button.disabled = false;
        }
    }

    /* ---------------- 图片 ---------------- */

    function targetSize() {
        const rot = Number(ui.rot.value) || 0;
        return rot % 2 === 0
            ? { w: SCREEN.short, h: SCREEN.long }
            : { w: SCREEN.long, h: SCREEN.short };
    }

    function drawImage() {
        if (!state.image) return;
        const size = targetSize();
        const canvas = ui.preview;
        canvas.width = size.w;
        canvas.height = size.h;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size.w, size.h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const img = state.image;
        const scale = ui.fit.value === 'contain'
            ? Math.min(size.w / img.width, size.h / img.height)
            : Math.max(size.w / img.width, size.h / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size.w - w) / 2, (size.h - h) / 2, w, h);

        state.bytes = toRGB565(ctx.getImageData(0, 0, size.w, size.h));
        ui.imgMeta.textContent = size.w + '×' + size.h + ' · ' + humanBytes(state.bytes.length);
        ui.drop.classList.add('has-image');
        refreshSendState();
    }

    function toRGB565(imageData) {
        const src = imageData.data;
        const count = imageData.width * imageData.height;
        const out = new Uint8Array(count * 2);
        for (let i = 0, j = 0; i < count; i++, j += 2) {
            const p = i * 4;
            const v = ((src[p] & 0xf8) << 8) | ((src[p + 1] & 0xfc) << 3) | (src[p + 2] >> 3);
            out[j] = (v >> 8) & 0xff;
            out[j + 1] = v & 0xff;
        }
        return out;
    }

    function loadFile(file) {
        if (!file || !/^image\//.test(file.type || '')) {
            log('这不是图片。', 'bad');
            return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
            URL.revokeObjectURL(url);
            state.image = img;
            drawImage();
            log('已载入 ' + file.name + '（' + img.width + '×' + img.height + '）');
        };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            log('这张图读不出来。', 'bad');
        };
        img.src = url;
    }

    function refreshSendState() {
        ui.send.disabled = !(state.image && state.connected) || state.busy;
    }

    async function sendFrame() {
        if (!state.bytes || !state.connected) return;
        const size = targetSize();
        const rot = Number(ui.rot.value) || 0;
        const bytes = state.bytes;
        const url = '/api/frame?w=' + size.w + '&h=' + size.h + '&rot=' + rot;

        state.busy = true;
        refreshSendState();
        ui.send.textContent = '发送中…';
        ui.barWrap.classList.add('is-run');
        ui.barWrap.classList.remove('is-done');
        const started = performance.now();

        try {
            const out = await api(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: bytes,
                timeout: 30000
            });
            const elapsed = (performance.now() - started) / 1000;
            const took = out.data && Number.isFinite(out.data.ms) ? out.data.ms + ' ms' : '—';
            log('整帧已送达：' + humanBytes(bytes.length) + '，往返 ' + elapsed.toFixed(2) +
                ' s，' + (bytes.length / 1024 / Math.max(elapsed, 0.01)).toFixed(0) + ' KB/s，屏上耗时 ' + took, 'ok');
            pushAnswer('发图', size.w + '×' + size.h + ' 已上屏，' + Math.round(elapsed * 1000) + ' ms', 'ok');
            ui.barWrap.classList.add('is-done');
            ui.bar.style.width = '100%';
            setTimeout(function () {
                ui.bar.style.width = '0';
                ui.barWrap.classList.remove('is-done');
            }, 900);
            if (ui.auto.checked) readStatus(false);
        } catch (err) {
            log('发图失败：' + explain(err), 'bad');
            pushAnswer('发图', explain(err), 'bad');
            ui.bar.style.width = '0';
        } finally {
            ui.barWrap.classList.remove('is-run');
            state.busy = false;
            ui.send.textContent = '发送到屏幕';
            refreshSendState();
        }
    }

    /* ---------------- 初始化 ---------------- */

    function initMixedWarning() {
        if (location.protocol !== 'https:') return;
        ui.mixed.hidden = false;
        ui.mixed.innerHTML =
            '这一页挂在 HTTPS 上，浏览器会拦掉对 <code>http://192.168.x.x</code> 的请求（混合内容），' +
            '连接会直接失败，跟板子没关系。三个办法：' +
            '<br>① 让 ESP32 自己托管这一页，用 <code>http://&lt;板子地址&gt;/</code> 打开，同源、没跨域；' +
            '<br>② 把这一页存到本地，用一个 http 的静态服务打开；' +
            '<br>③ 临时放行：<code>chrome://flags</code> 里把 <code>unsafely-treat-insecure-origin-as-secure</code> ' +
            '加上板子地址。';
    }

    function initBase() {
        const saved = localStorage.getItem(STORE_KEY);
        if (saved) {
            ui.base.value = saved.replace(/^https?:\/\//, '');
            return;
        }
        // 如果这一页本身就是从板子上（http，非 localhost）打开的，默认同源
        if (location.protocol === 'http:' &&
            location.hostname !== 'localhost' &&
            location.hostname !== '127.0.0.1') {
            ui.base.value = location.host;
        }
    }

    ui.connect.addEventListener('click', connect);
    ui.dropLink.addEventListener('click', disconnect);
    ui.base.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') connect();
    });
    ui.auto.addEventListener('change', function () {
        if (ui.auto.checked && state.connected) startPolling();
        else stopPolling();
    });

    document.querySelectorAll('.esp-ask').forEach(function (button) {
        button.addEventListener('click', function () {
            runAsk(button.dataset.cmd, button);
        });
    });

    ui.drop.addEventListener('click', function () { ui.file.click(); });
    ui.file.addEventListener('change', function () {
        if (ui.file.files && ui.file.files[0]) loadFile(ui.file.files[0]);
        ui.file.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (name) {
        ui.drop.addEventListener(name, function (e) {
            e.preventDefault();
            ui.drop.classList.add('is-over');
        });
    });
    ['dragleave', 'drop'].forEach(function (name) {
        ui.drop.addEventListener(name, function (e) {
            e.preventDefault();
            ui.drop.classList.remove('is-over');
        });
    });
    ui.drop.addEventListener('drop', function (e) {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) loadFile(file);
    });

    ui.rot.addEventListener('change', drawImage);
    ui.fit.addEventListener('change', drawImage);
    ui.send.addEventListener('click', sendFrame);
    ui.clearLog.addEventListener('click', function () {
        clearChildren(ui.log);
        log('日志已清空。');
    });

    initBase();
    initMixedWarning();
    refreshSendState();
    log('就绪。填板子地址，点连接。');
})();
