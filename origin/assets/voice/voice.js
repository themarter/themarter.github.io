/* ============================================================
   /voice —— 把文字发给本机的 VoxCPM 服务，把音频接回来
   结构见 index.html，样式见 voice.css

   服务端 /api/tts/stream 吐的是裸 float32（chunked），
   这里边收边算「已生成几秒」，收完再自己补 WAV 头。
   不边播边生成的原因：显卡比实时慢 8 倍，边播一定卡。
   ============================================================ */

(function () {
    'use strict';

    const DEFAULT_BASE = 'http://127.0.0.1:8760';
    const STORE_BASE = 'voice.base';
    const SEC_PER_CHAR = 0.24;      // 中文语速的经验值，只用来估总长度
    const POLL_MS = 5000;

    const ui = {
        text: document.getElementById('text'),
        count: document.getElementById('count'),
        steps: document.getElementById('steps'),
        cfg: document.getElementById('cfg'),
        gen: document.getElementById('gen'),
        again: document.getElementById('again'),
        bar: document.getElementById('bar'),
        tip: document.getElementById('tip'),
        meta: document.getElementById('play-meta'),
        wave: document.getElementById('wave'),
        waveBox: document.querySelector('.vc-wave'),
        audio: document.getElementById('audio'),
        download: document.getElementById('download'),
        base: document.getElementById('base'),
        reconnect: document.getElementById('reconnect'),
        dot: document.getElementById('dot'),
        hint: document.getElementById('hint'),
        device: document.getElementById('s-device'),
        vram: document.getElementById('s-vram'),
        sr: document.getElementById('s-sr'),
        count2: document.getElementById('s-count'),
        historyCard: document.getElementById('history-card'),
        history: document.getElementById('history')
    };

    const state = {
        base: DEFAULT_BASE,
        ready: false,
        busy: false,
        timer: null,
        samples: null,
        sampleRate: 48000,
        audioUrl: null,
        generatedSec: 0,
        lastText: '',
        lastMs: 0,
        entries: []
    };

    /* ---------------- 小工具 ---------------- */

    function setTip(text, tone) {
        ui.tip.textContent = text;
        if (tone) ui.tip.dataset.tone = tone;
        else delete ui.tip.dataset.tone;
    }

    function setDot(value) {
        ui.dot.dataset.state = value;
    }

    function setStat(node, text) {
        node.textContent = text || '—';
        node.classList.toggle('is-empty', !text);
    }

    function mmss(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '0:00';
        const s = Math.floor(sec);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function humanBytes(n) {
        if (!Number.isFinite(n)) return '—';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' MB';
        return (n / 1073741824).toFixed(1) + ' GB';
    }

    function normalizeBase(raw) {
        let value = String(raw || '').trim();
        if (!value) return '';
        value = value.replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
        try {
            return new URL(value).origin;
        } catch (err) {
            return '';
        }
    }

    function isLoopback(base) {
        return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base);
    }

    function explain(err) {
        if (err.name === 'AbortError') return '已取消。';
        if (err instanceof TypeError) {
            if (location.protocol === 'https:' && !isLoopback(state.base)) {
                return '被浏览器拦了：HTTPS 页面只能连 127.0.0.1 这类本机地址，连局域网 IP 会被当成混合内容。';
            }
            return '连不上 ' + state.base + '，先看服务是不是还开着。';
        }
        return err.message || String(err);
    }

    /* ---------------- 服务状态 ---------------- */

    async function pollStatus(verbose) {
        try {
            const res = await fetch(state.base + '/api/status', { cache: 'no-store' });
            const data = await res.json();
            renderStatus(data);
            if (data.error) {
                setDot('off');
                setTip('模型加载失败：' + data.error, 'bad');
            } else if (data.ready) {
                setDot('on');
            } else {
                setDot('busy');
            }
            return data;
        } catch (err) {
            state.ready = false;
            setDot('off');
            setStat(ui.device, '');
            setStat(ui.vram, '');
            setStat(ui.sr, '');
            setStat(ui.count2, '');
            if (verbose) setTip(explain(err), 'bad');
            return null;
        }
    }

    function renderStatus(d) {
        state.ready = !!d.ready;
        if (Number.isFinite(d.sampleRate) && d.sampleRate > 0) state.sampleRate = d.sampleRate;

        const device = d.gpu || d.device || '';
        setStat(ui.device, device);
        setStat(ui.vram, Number.isFinite(d.vramFree)
            ? humanBytes(d.vramFree) + ' / ' + humanBytes(d.vramTotal)
            : '');
        setStat(ui.sr, Number.isFinite(d.sampleRate) ? (d.sampleRate / 1000) + ' kHz' : '');
        setStat(ui.count2, Number.isFinite(d.requests) ? d.requests + ' 次' : '');

        if (d.ready) {
            ui.hint.textContent = '服务在线。文字只在这条本机连接里走。';
        } else if (d.error) {
            ui.hint.textContent = '服务端报错，看那个终端窗口。';
        } else {
            ui.hint.textContent = '服务在启动，模型加载大约 50 秒。';
        }
    }

    function startPolling() {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(function () {
            if (!state.busy) pollStatus(false);
        }, POLL_MS);
    }

    /* ---------------- 波形 ---------------- */

    function drawWave(data, progress) {
        const canvas = ui.wave;
        const cssW = canvas.clientWidth || 600;
        const cssH = 90;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        if (!data || !data.length) return;

        const bars = Math.max(24, Math.floor(cssW / 3));
        const step = Math.max(1, Math.floor(data.length / bars));
        const mid = cssH / 2;

        for (let i = 0; i < bars; i++) {
            let peak = 0;
            const start = i * step;
            for (let j = 0; j < step; j += 3) {
                const v = Math.abs(data[start + j] || 0);
                if (v > peak) peak = v;
            }
            const h = Math.max(1.4, Math.min(1, peak * 2.8) * (cssH - 6));
            const played = (i / bars) <= progress;
            ctx.fillStyle = played ? 'rgba(47, 107, 88, 0.82)' : 'rgba(180, 176, 168, 0.5)';
            ctx.fillRect(i * 3 + 0.5, mid - h / 2, 2, h);
        }
    }

    let rafId = null;
    function trackPlayback() {
        if (rafId) cancelAnimationFrame(rafId);
        const tick = function () {
            if (!state.samples) return;
            const ratio = ui.audio.duration ? ui.audio.currentTime / ui.audio.duration : 0;
            drawWave(state.samples, ratio);
            if (!ui.audio.paused && !ui.audio.ended) rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    }

    /* ---------------- WAV ---------------- */

    function encodeWav(samples, sampleRate) {
        const len = samples.length;
        const buffer = new ArrayBuffer(44 + len * 2);
        const view = new DataView(buffer);
        const str = function (offset, text) {
            for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
        };

        str(0, 'RIFF');
        view.setUint32(4, 36 + len * 2, true);
        str(8, 'WAVE');
        str(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        str(36, 'data');
        view.setUint32(40, len * 2, true);

        let offset = 44;
        for (let i = 0; i < len; i++) {
            const v = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
            offset += 2;
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    /* ---------------- 生成 ---------------- */

    async function generate() {
        const text = ui.text.value.trim();
        if (!text) {
            setTip('先写点什么。', 'bad');
            ui.text.focus();
            return;
        }
        if (!state.ready) {
            setTip('服务还没就绪，' + (state.ready === false ? '先看下面那盏灯。' : ''), 'bad');
            return;
        }
        if (state.busy) return;

        state.busy = true;
        state.lastText = text;
        state.lastMs = 0;
        ui.gen.disabled = true;
        ui.gen.textContent = '生成中…';
        ui.again.hidden = true;
        ui.download.hidden = true;
        ui.audio.hidden = true;
        ui.bar.style.width = '0';
        ui.bar.parentElement.classList.remove('is-done');
        ui.waveBox.classList.remove('is-live');
        ui.meta.textContent = '生成中';

        const started = performance.now();
        const estimate = Math.max(1.5, text.length * SEC_PER_CHAR);

        const timer = setInterval(function () {
            const elapsed = (performance.now() - started) / 1000;
            const done = (state.generatedSec || 0);
            setTip('已生成 ' + done.toFixed(1) + ' 秒 · 预计 ' + estimate.toFixed(1) +
                ' 秒 · 已用时 ' + elapsed.toFixed(0) + ' 秒');
        }, 400);

        try {
            const res = await fetch(state.base + '/api/tts/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    steps: Number(ui.steps.value) || 10,
                    cfg: Number(ui.cfg.value) || 2
                })
            });

            if (!res.ok) {
                let msg = 'HTTP ' + res.status;
                try {
                    const data = await res.json();
                    if (data && data.msg) msg = data.msg;
                } catch (err) { /* 不是 JSON 就算了 */ }
                throw new Error(msg);
            }

            const rate = Number(res.headers.get('X-Sample-Rate')) || state.sampleRate;
            state.sampleRate = rate;

            const reader = res.body.getReader();
            const chunks = [];
            let carry = new Uint8Array(0);
            let total = 0;

            while (true) {
                const out = await reader.read();
                if (out.done) break;

                const merged = new Uint8Array(carry.length + out.value.length);
                merged.set(carry);
                merged.set(out.value, carry.length);

                const usable = merged.length - (merged.length % 4);
                if (usable > 0) {
                    const view = new Float32Array(merged.buffer.slice(merged.byteOffset, merged.byteOffset + usable));
                    chunks.push(view);
                    total += view.length;
                    state.generatedSec = total / rate;
                    const ratio = Math.min(0.97, state.generatedSec / estimate);
                    ui.bar.style.width = (ratio * 100).toFixed(1) + '%';
                }
                carry = merged.slice(usable);
            }

            if (!total) throw new Error('服务端没返回音频');

            const all = new Float32Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                all.set(chunk, offset);
                offset += chunk.length;
            }

            state.samples = all;
            state.lastMs = Math.round(performance.now() - started);

            if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
            state.audioUrl = URL.createObjectURL(encodeWav(all, rate));

            ui.audio.src = state.audioUrl;
            ui.audio.hidden = false;
            ui.download.href = state.audioUrl;
            ui.download.download = 'voice-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '.wav';
            ui.download.hidden = false;
            ui.again.hidden = false;
            ui.waveBox.classList.add('is-live');
            drawWave(all, 0);

            const seconds = total / rate;
            const rtf = seconds > 0 ? (state.lastMs / 1000) / seconds : 0;
            ui.meta.textContent = mmss(seconds) + ' · ' + (total * 2 / 1024 / 1024).toFixed(2) + ' MB';
            ui.bar.style.width = '100%';
            ui.bar.parentElement.classList.add('is-done');
            setTip('好了：' + seconds.toFixed(2) + ' 秒音频，用了 ' + (state.lastMs / 1000).toFixed(1) +
                ' 秒生成（约 ' + rtf.toFixed(1) + ' 倍实时）。点播放。', 'ok');

            addHistory(text, state.audioUrl, seconds);
        } catch (err) {
            setTip(explain(err), 'bad');
            ui.meta.textContent = '没有声音';
            ui.bar.style.width = '0';
        } finally {
            clearInterval(timer);
            state.busy = false;
            state.generatedSec = 0;
            ui.gen.disabled = false;
            ui.gen.textContent = '生成语音';
            pollStatus(false);
        }
    }

    /* ---------------- 历史 ---------------- */

    function addHistory(text, url, seconds) {
        state.entries.unshift({
            text: text,
            url: url,
            seconds: seconds,
            at: new Date().toTimeString().slice(0, 5)
        });
        while (state.entries.length > 8) state.entries.pop();
        renderHistory();
    }

    function renderHistory() {
        ui.history.textContent = '';
        state.entries.forEach(function (entry, index) {
            const li = document.createElement('li');
            const time = document.createElement('time');
            time.textContent = entry.at;
            const text = document.createElement('span');
            text.className = 'vc-history__text';
            text.textContent = entry.text;
            const len = document.createElement('span');
            len.className = 'vc-history__len';
            len.textContent = entry.seconds.toFixed(1) + 's';
            const play = document.createElement('button');
            play.type = 'button';
            play.textContent = index === 0 ? '当前' : '重播';
            play.disabled = index === 0;
            play.addEventListener('click', function () {
                ui.audio.src = entry.url;
                ui.audio.hidden = false;
                ui.meta.textContent = mmss(entry.seconds);
                ui.waveBox.classList.add('is-live');
                ui.audio.play().catch(function () { });
            });
            li.append(time, text, len, play);
            ui.history.append(li);
        });
        ui.historyCard.hidden = state.entries.length === 0;
    }

    /* ---------------- 初始化 ---------------- */

    function initBase() {
        const saved = localStorage.getItem(STORE_BASE);
        state.base = saved || DEFAULT_BASE;
        ui.base.value = state.base.replace(/^https?:\/\//, '');
    }

    function applyBase() {
        const next = normalizeBase(ui.base.value);
        if (!next) {
            setTip('地址不对，形如 127.0.0.1:8760。', 'bad');
            return;
        }
        state.base = next;
        localStorage.setItem(STORE_BASE, next);
        ui.base.value = next.replace(/^https?:\/\//, '');
        setDot('busy');
        setTip('正在找 ' + next + ' …');
        pollStatus(true).then(function (data) {
            if (data && data.ready) {
                setTip('服务在线，可以生成了。', 'ok');
            } else if (data && !data.ready) {
                setTip('服务在，但模型还在加载，等半分钟。');
            }
        });
    }

    ui.text.addEventListener('input', function () {
        ui.count.textContent = ui.text.value.length + ' / 600';
    });

    document.querySelectorAll('#chips button').forEach(function (button) {
        button.addEventListener('click', function () {
            ui.text.value = button.dataset.text;
            ui.text.dispatchEvent(new Event('input'));
            ui.text.focus();
        });
    });

    ui.gen.addEventListener('click', generate);
    ui.again.addEventListener('click', function () {
        ui.text.value = state.lastText;
        ui.text.dispatchEvent(new Event('input'));
        generate();
    });
    ui.reconnect.addEventListener('click', applyBase);
    ui.base.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') applyBase();
    });
    ui.audio.addEventListener('play', trackPlayback);
    ui.audio.addEventListener('timeupdate', function () {
        if (!ui.audio.paused && state.samples) {
            drawWave(state.samples, ui.audio.duration ? ui.audio.currentTime / ui.audio.duration : 0);
        }
    });
    ui.audio.addEventListener('ended', function () {
        drawWave(state.samples, 1);
    });
    window.addEventListener('resize', function () {
        if (state.samples) {
            const ratio = ui.audio.duration ? ui.audio.currentTime / ui.audio.duration : 0;
            drawWave(state.samples, ratio);
        }
    });

    initBase();
    drawWave(null, 0);
    ui.count.textContent = '0 / 600';
    pollStatus(false).then(function (data) {
        if (data && data.ready) setTip('服务在线，可以生成了。', 'ok');
    });
    startPolling();
})();
