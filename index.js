/**
 * Context Lens — a context-window dashboard for SillyTavern (Chat Completion APIs)
 *
 * What it does:
 *  - Hooks CHAT_COMPLETION_PROMPT_READY to inspect the exact messages sent to the API
 *  - Attributes tokens to: main prompt, character card, persona, world info,
 *    chat history, author's note / extension prompts, and per-message overhead
 *  - Shows a stacked token-budget gauge (with the response reserve), a fill
 *    donut, per-category bars, active world info entries (with trigger keys and
 *    token cost), a per-message history strip with the cut-off line, and a
 *    fill trend over recent sends
 *
 * Install: drop this folder into  data/<user>/extensions/  (or use
 * Extensions ▸ Install extension with the repo URL). Chat-completion only.
 */

(() => {
    'use strict';

    const MODULE = 'contextLens';

    /* ------------------------------------------------------------------ */
    /* Constants                                                           */
    /* ------------------------------------------------------------------ */

    const CATS = {
        main:     { label: 'Main prompt',      color: '#8B7CFF' },
        card:     { label: 'Character card',   color: '#FF6B9D' },
        persona:  { label: 'Persona',          color: '#5DA9FF' },
        wi:       { label: 'World info',       color: '#FFB347' },
        history:  { label: 'Chat history',     color: '#4ECDC4' },
        note:     { label: "Author's note +",  color: '#A8E05F' },
        overhead: { label: 'Other / overhead', color: '#7E8799' },
    };

    const LEVEL_COLORS = { ok: '#4ECDC4', warn: '#FFB347', crit: '#FF6B6B' };

    const DEFAULTS = { x: null, y: null, w: null, h: null, open: false, collapsed: false, sections: {} };

    const PER_MESSAGE_OVERHEAD = 3; // rough ChatML wrapper cost per message
    const STRIP_WINDOW = 48;        // messages shown in the history strip
    const TREND_LEN = 24;           // real sends kept for the trend sparkline
    const DONUT_R = 33;
    const DONUT_C = 2 * Math.PI * DONUT_R;

    /* ------------------------------------------------------------------ */
    /* State                                                               */
    /* ------------------------------------------------------------------ */

    let lastActivatedWI = [];   // entries captured from WORLD_INFO_ACTIVATED
    let lastAnalysis = null;    // result of the most recent prompt analysis
    let trend = [];             // { used, budget } for recent non-dry sends
    let pendingJob = null;      // latest prompt waiting to be analyzed
    let running = false;
    let initialized = false;

    const tokenCache = new Map();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    // Keep in sync with the sheet breakpoint in style.css
    const sheetQuery = window.matchMedia?.('(max-width: 600px)');
    const isSheet = () => !!sheetQuery?.matches;

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    const ctx = () => SillyTavern.getContext();

    function settings() {
        const es = ctx().extensionSettings;
        es[MODULE] = Object.assign({}, DEFAULTS, es[MODULE]);
        es[MODULE].sections = es[MODULE].sections || {};
        return es[MODULE];
    }

    async function countTokens(text) {
        const c = ctx();
        try {
            if (typeof c.getTokenCountAsync === 'function') return await c.getTokenCountAsync(text);
            if (typeof c.getTokenCount === 'function') return c.getTokenCount(text);
        } catch (e) { /* fall through */ }
        return Math.ceil(text.length / 3.5); // crude fallback
    }

    async function tokens(text) {
        if (!text) return 0;
        if (tokenCache.has(text)) return tokenCache.get(text);
        const n = await countTokens(text);
        if (tokenCache.size > 3000) tokenCache.clear();
        tokenCache.set(text, n);
        return n;
    }

    function maxContext() {
        const c = ctx();
        return c.chatCompletionSettings?.openai_max_context
            ?? c.maxContext
            ?? 0;
    }

    function responseReserve() {
        return Number(ctx().chatCompletionSettings?.openai_max_tokens) || 0;
    }

    function sub(text) {
        try { return ctx().substituteParams(text ?? '') ?? ''; }
        catch { return text ?? ''; }
    }

    /** Flatten chat-completion message content (string or multimodal array) to text. */
    function msgText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
        }
        return '';
    }

    const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

    function fmt(n) {
        return Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, m =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    /** Animate a number inside an element from its last value to `to`. */
    function setNum(el, to, format = fmt) {
        if (!el) return;
        const from = Number(el.dataset.v ?? 0);
        el.dataset.v = to;
        cancelAnimationFrame(el._raf);
        if (reducedMotion?.matches || from === to) { el.textContent = format(to); return; }
        const t0 = performance.now();
        const step = (t) => {
            const k = Math.min(1, (t - t0) / 450);
            const e = 1 - Math.pow(1 - k, 3);
            el.textContent = format(Math.round(from + (to - from) * e));
            if (k < 1) el._raf = requestAnimationFrame(step);
        };
        el._raf = requestAnimationFrame(step);
    }

    /* ------------------------------------------------------------------ */
    /* Prompt analysis                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Build the list of "known sources" we try to find inside prompt messages,
     * each tagged with the category its tokens should be attributed to.
     */
    function knownSources() {
        const c = ctx();
        const sources = [];

        // World info entries captured from the activation event
        for (const e of lastActivatedWI) {
            const text = sub(e.content)?.trim();
            if (text) sources.push({ cat: 'wi', text });
        }

        // Character card fields
        const char = c.characters?.[c.characterId];
        if (char) {
            for (const f of [char.description, char.personality, char.scenario,
                             char.mes_example, char.data?.system_prompt,
                             char.data?.post_history_instructions]) {
                const text = sub(f)?.trim();
                if (text) sources.push({ cat: 'card', text });
            }
        }

        const persona = sub(c.powerUserSettings?.persona_description)?.trim();
        if (persona) sources.push({ cat: 'persona', text: persona });

        // Prompt Manager prompts (main, NSFW, jailbreak / post-history, custom)
        const prompts = c.chatCompletionSettings?.prompts;
        if (Array.isArray(prompts)) {
            for (const p of prompts) {
                if (p?.marker) continue;
                const text = sub(p?.content)?.trim();
                if (text) sources.push({ cat: 'main', text });
            }
        }

        // Author's note + anything other extensions inject
        const ext = c.extensionPrompts || {};
        for (const key of Object.keys(ext)) {
            const text = sub(ext[key]?.value)?.trim();
            if (text) sources.push({ cat: 'note', text });
        }

        // Longest first so big blocks are claimed before fragments
        sources.sort((a, b) => b.text.length - a.text.length);
        return sources;
    }

    /** Does a prompt history message correspond to this chat message text? */
    function histMatch(promptText, chatText) {
        if (!chatText) return false;
        if (promptText === chatText) return true;
        if (promptText.endsWith(`: ${chatText}`)) return true; // "Name: message"
        return chatText.length >= 12 && promptText.includes(chatText);
    }

    /**
     * Walk the prompt's user/assistant messages backwards, aligning each with
     * the newest unclaimed chat message. Aligning in order (rather than
     * searching the whole chat) keeps short repeated messages like "ok" from
     * matching something far back in history.
     */
    function alignHistory(promptHist, histTexts, hidden) {
        const found = new Set();
        let j = histTexts.length - 1;
        for (let k = promptHist.length - 1; k >= 0 && j >= 0; k--) {
            for (let i = j, skips = 0; i >= 0 && skips <= 8; i--) {
                if (hidden[i] || !histTexts[i]) continue;
                if (histMatch(promptHist[k], histTexts[i])) {
                    found.add(i);
                    j = i - 1;
                    break;
                }
                skips++;
            }
        }
        return found.size ? Math.min(...found) : null;
    }

    function queueAnalyze(chat, dryRun) {
        // Copy now: ST may keep mutating its prompt array after the event.
        pendingJob = {
            chat: chat.map(m => ({ role: m.role, text: msgText(m.content) })),
            dryRun: !!dryRun,
        };
        if (running) return;
        running = true;
        (async () => {
            try {
                while (pendingJob) {
                    const job = pendingJob;
                    pendingJob = null;
                    await analyze(job.chat, job.dryRun);
                }
            } catch (e) {
                console.error('[Context Lens] analysis failed', e);
            } finally {
                running = false;
            }
        })();
    }

    /**
     * Analyze the assembled chat-completion prompt.
     * @param {Array<{role:string, text:string}>} chat
     * @param {boolean} dryRun
     */
    async function analyze(chat, dryRun) {
        const c = ctx();
        const sources = knownSources();

        const totals = Object.fromEntries(Object.keys(CATS).map(k => [k, 0]));
        const wiHits = new Set();
        const promptHist = [];
        let firstSystemSeen = false;

        for (const m of chat) {
            let text = m.text;
            totals.overhead += PER_MESSAGE_OVERHEAD;
            if (!text) continue;
            const isHist = m.role === 'user' || m.role === 'assistant';
            if (isHist) promptHist.push(norm(text));

            // 1. Claim known sources embedded in this message
            for (const s of sources) {
                if (s.text.length >= 8 && text.includes(s.text)) {
                    totals[s.cat] += await tokens(s.text);
                    if (s.cat === 'wi') wiHits.add(s.text);
                    text = text.replace(s.text, '\u0000');
                }
            }
            const remainder = text.replaceAll('\u0000', '').trim();
            if (!remainder) continue;
            const remTok = await tokens(remainder);

            // 2. Categorize the remainder
            if (isHist) {
                totals.history += remTok;
            } else if (!firstSystemSeen) {
                firstSystemSeen = true;
                totals.main += remTok;
            } else {
                totals.overhead += remTok;
            }
        }

        // Truncation line: which chat messages made it into the prompt?
        const chatMsgs = c.chat || [];
        const histTexts = chatMsgs.map(m => norm(sub(m.mes ?? '')));
        const hidden = chatMsgs.map(m => !!m.is_system);
        const oldestIncluded = alignHistory(promptHist, histTexts, hidden);
        const visible = i => !hidden[i] && !!histTexts[i];
        const visibleCount = histTexts.filter((_, i) => visible(i)).length;
        const hiddenCount = hidden.filter(Boolean).length;
        let droppedCount = 0;
        if (oldestIncluded !== null) {
            for (let i = 0; i < oldestIncluded; i++) if (visible(i)) droppedCount++;
        }

        const status = (i) => {
            if (hidden[i]) return 'hidden';
            if (oldestIncluded === null) return 'unknown';
            return i >= oldestIncluded ? 'in' : 'out';
        };

        // Per-message token strip for the tail of the chat
        const start = Math.max(0, histTexts.length - STRIP_WINDOW);
        const strip = await Promise.all(histTexts.slice(start).map(async (t, n) => {
            const i = start + n;
            return { index: i, isUser: !!chatMsgs[i]?.is_user, status: status(i), tokens: await tokens(t) };
        }));

        const wi = await Promise.all(lastActivatedWI.map(async (e) => {
            const text = sub(e.content)?.trim() ?? '';
            const hit = wiHits.has(text);
            return {
                comment: e.comment || e.key?.join?.(', ') || '(untitled)',
                keys: Array.isArray(e.key) ? e.key.filter(Boolean) : [],
                constant: !!e.constant,
                world: e.world || '',
                hit,
                tokens: hit ? await tokens(text) : 0,
            };
        }));
        wi.sort((a, b) => (b.hit - a.hit) || (b.tokens - a.tokens));

        const used = Object.values(totals).reduce((a, b) => a + b, 0);
        const max = maxContext();
        const reserve = Math.min(responseReserve(), max);
        const budget = max ? Math.max(1, max - reserve) : used;

        const prev = trend.at(-1);
        const delta = prev ? used - prev.used : null;
        if (!dryRun) {
            trend.push({ used, budget });
            if (trend.length > TREND_LEN) trend = trend.slice(-TREND_LEN);
        }

        lastAnalysis = {
            totals,
            used,
            max,
            reserve,
            budget,
            pct: budget ? (used / budget) * 100 : 0,
            delta,
            dryRun,
            messageCount: chat.length,
            wi,
            oldestIncluded,
            droppedCount,
            hiddenCount,
            visibleCount,
            historyLen: histTexts.length,
            stripStart: start,
            strip,
            when: new Date(),
        };
        render();
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                           */
    /* ------------------------------------------------------------------ */

    function panel() { return document.getElementById('ctxlens_panel'); }

    function level(pct) {
        return pct > 92 ? 'crit' : pct > 75 ? 'warn' : 'ok';
    }

    function section(id, title, inner) {
        const collapsed = settings().sections[id] ? ' ctxlens-collapsed' : '';
        return `<div class="ctxlens-group${collapsed}" data-section="${id}">
            <button type="button" class="ctxlens-h" aria-expanded="${!collapsed}">
                <i class="fa-solid fa-chevron-down ctxlens-chev"></i>
                ${title} <span class="ctxlens-h-count"></span>
            </button>
            <div class="ctxlens-section">${inner}</div>
        </div>`;
    }

    /** Static panel structure; render() only updates values inside it. */
    function skeleton() {
        const segs = Object.entries(CATS).map(([k, def]) =>
            `<div class="ctxlens-seg" data-cat="${k}" style="background:${def.color}"></div>`).join('');
        const rows = Object.entries(CATS).map(([k, def]) => `
            <div class="ctxlens-row" data-cat="${k}">
                <span class="ctxlens-dot" style="background:${def.color}"></span>
                <span class="ctxlens-row-label">${def.label}</span>
                <span class="ctxlens-row-bar"><i style="background:${def.color}"></i></span>
                <span class="ctxlens-row-num"><b>0</b> <em>0%</em></span>
            </div>`).join('');

        return `
            <div class="ctxlens-empty">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <p>Send a message (or trigger a generation) and the assembled
                prompt will be analyzed here.</p>
            </div>
            <div class="ctxlens-content">
                <div class="ctxlens-top">
                    <div class="ctxlens-donut">
                        <svg viewBox="0 0 80 80" aria-hidden="true">
                            <circle class="ctxlens-donut-track" cx="40" cy="40" r="${DONUT_R}"></circle>
                            <circle class="ctxlens-donut-arc" cx="40" cy="40" r="${DONUT_R}"
                                stroke-dasharray="${DONUT_C}" stroke-dashoffset="${DONUT_C}"></circle>
                        </svg>
                        <div class="ctxlens-donut-hole"><b data-f="pct">0%</b><span>of budget</span></div>
                    </div>
                    <div class="ctxlens-top-stats">
                        <div class="ctxlens-big">
                            <b data-f="used">0</b>
                            <span>/ <span data-f="budget">?</span> tokens</span>
                            <span class="ctxlens-delta" data-f="delta"></span>
                        </div>
                        <div class="ctxlens-gauge">
                            ${segs}
                            <div class="ctxlens-free"></div>
                            <div class="ctxlens-reserve"></div>
                        </div>
                        <div class="ctxlens-gauge-scale">
                            <span>0</span><span data-f="reserve-label"></span><span data-f="max">?</span>
                        </div>
                        <div class="ctxlens-sub" data-f="sub"></div>
                    </div>
                </div>

                <div class="ctxlens-section ctxlens-breakdown">${rows}</div>

                ${section('wi', 'World info', '<div data-f="wi"></div>')}
                ${section('history', 'Chat history', `
                    <div data-f="trunc"></div>
                    <div class="ctxlens-strip" data-f="strip"></div>
                    <div class="ctxlens-strip-legend">
                        <span><i class="sw user"></i>you</span>
                        <span><i class="sw ai"></i>AI</span>
                        <span><i class="sw out"></i>dropped</span>
                        <span><i class="sw hidden"></i>hidden</span>
                        <span class="ctxlens-strip-hint">
                            <span class="ctxlens-hint-mouse">click a bar to jump</span>
                            <span class="ctxlens-hint-touch">tap or slide to inspect</span>
                        </span>
                    </div>`)}
                ${section('trend', 'Fill over recent sends', '<div data-f="trend"></div>')}
            </div>`;
    }

    function renderWI(a) {
        if (!a.wi.length) return `<div class="ctxlens-muted">No lorebook entries fired this turn.</div>`;
        const maxTok = Math.max(...a.wi.map(e => e.tokens), 1);
        return a.wi.map(e => {
            const keys = e.constant
                ? '<span class="ctxlens-chip ctxlens-chip-const">constant</span>'
                : e.keys.slice(0, 4).map(k => `<span class="ctxlens-chip">${esc(k)}</span>`).join('')
                  + (e.keys.length > 4 ? `<span class="ctxlens-chip ctxlens-chip-more" data-tip="${esc(e.keys.slice(4).join(', '))}">+${e.keys.length - 4}</span>` : '');
            const title = e.hit
                ? `${e.tokens} tokens${e.world ? ` · ${e.world}` : ''}`
                : 'Activated, but not found in the prompt (budget cap, filters, or macros)';
            return `
                <div class="ctxlens-wi ${e.hit ? '' : 'ctxlens-wi-miss'}" data-tip="${esc(title)}">
                    <div class="ctxlens-wi-line">
                        <span class="ctxlens-wi-name">${esc(e.comment)}</span>
                        ${e.world ? `<span class="ctxlens-wi-world">${esc(e.world)}</span>` : ''}
                        <span class="ctxlens-wi-tok">${e.hit ? fmt(e.tokens) : 'not sent'}</span>
                    </div>
                    <div class="ctxlens-wi-meter"><i style="width:${(e.tokens / maxTok) * 100}%"></i></div>
                    <div class="ctxlens-wi-keys">${keys}</div>
                </div>`;
        }).join('');
    }

    function renderTrunc(a) {
        const hiddenNote = a.hiddenCount
            ? ` <span class="ctxlens-muted-inline">(${a.hiddenCount} hidden)</span>` : '';
        if (a.visibleCount === 0) {
            return `<div class="ctxlens-muted">Chat is empty.${hiddenNote}</div>`;
        }
        if (a.oldestIncluded === null) {
            return `<div class="ctxlens-trunc unknown"><i class="fa-solid fa-circle-question"></i>
                Couldn't line chat messages up with the prompt — regex scripts or
                macros may be rewriting them.</div>`;
        }
        if (a.droppedCount === 0) {
            return `<div class="ctxlens-trunc ok"><i class="fa-solid fa-circle-check"></i>
                Entire chat history fits in context.${hiddenNote}</div>`;
        }
        return `<div class="ctxlens-trunc warn"><i class="fa-solid fa-scissors"></i>
            Oldest message in context: <b>#${a.oldestIncluded + 1}</b> —
            <b>${a.droppedCount}</b> older message${a.droppedCount === 1 ? '' : 's'} fell out.${hiddenNote}</div>`;
    }

    function renderStrip(a) {
        const maxTok = Math.max(...a.strip.map(s => s.tokens), 1);
        let html = a.stripStart > 0
            ? `<div class="ctxlens-strip-more" data-tip="${a.stripStart} earlier messages not shown">+${a.stripStart}</div>`
            : '';
        a.strip.forEach((s, n) => {
            const prev = a.strip[n - 1];
            if (s.status === 'in' && prev && prev.status !== 'in' && s.index === a.oldestIncluded) {
                html += `<div class="ctxlens-cut" data-tip="Context cut-off"></div>`;
            }
            const label = { in: 'in context', out: 'dropped', hidden: 'hidden', unknown: 'unknown' }[s.status];
            html += `<div class="ctxlens-bar ${s.status} ${s.isUser ? 'user' : 'ai'}" data-mes="${s.index}"
                data-tip="#${s.index + 1} · ${s.tokens} tok · ${label}"
                style="height:${Math.max(8, (s.tokens / maxTok) * 100)}%"></div>`;
        });
        return html;
    }

    function renderTrend() {
        if (trend.length < 2) {
            return `<div class="ctxlens-muted">Appears after a couple of sends in this chat.</div>`;
        }
        const W = 300, H = 46, pad = 3;
        const vals = trend.map(t => (t.used / (t.budget || t.used || 1)) * 100);
        const top = Math.max(110, ...vals);
        const x = i => pad + (i / (vals.length - 1)) * (W - pad * 2);
        const y = v => H - pad - (v / top) * (H - pad * 2);
        const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        const area = `${x(0)},${H - pad} ${pts} ${x(vals.length - 1)},${H - pad}`;
        const last = vals.at(-1);
        return `
            <svg class="ctxlens-trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                <line class="ctxlens-trend-limit" x1="0" x2="${W}" y1="${y(100)}" y2="${y(100)}"></line>
                <polygon class="ctxlens-trend-area" points="${area}"></polygon>
                <polyline class="ctxlens-trend-line" points="${pts}"></polyline>
                <circle class="ctxlens-trend-dot" cx="${x(vals.length - 1)}" cy="${y(last)}" r="2.6"
                    style="fill:${LEVEL_COLORS[level(last)]}"></circle>
            </svg>
            <div class="ctxlens-trend-cap">
                <span>last ${vals.length} sends</span>
                <span>min ${Math.round(Math.min(...vals))}% · max ${Math.round(Math.max(...vals))}%</span>
            </div>`;
    }

    function render() {
        const p = panel();
        if (!p || !settings().open) return;
        const a = lastAnalysis;
        clearInspect(p);
        p.classList.toggle('ctxlens-has-data', !!a);
        const pill = p.querySelector('.ctxlens-pill');
        const mini = p.querySelector('.ctxlens-mini i');
        if (!a) {
            pill.textContent = '—';
            mini.style.width = '0';
            delete p.dataset.level;
            return;
        }

        const q = sel => p.querySelector(`[data-f="${sel}"]`);
        const lvl = level(a.pct);
        p.dataset.level = lvl;
        p.style.setProperty('--cl-level', LEVEL_COLORS[lvl]);

        /* --- header pill + mini gauge (visible when collapsed) --- */
        pill.textContent = `${Math.round(a.pct)}%`;
        mini.style.width = `${Math.min(100, a.pct)}%`;

        /* --- donut + headline numbers --- */
        p.querySelector('.ctxlens-donut-arc').style.strokeDashoffset =
            String(DONUT_C * (1 - Math.min(100, a.pct) / 100));
        setNum(q('pct'), Math.round(a.pct), n => `${n}%`);
        setNum(q('used'), a.used);
        q('budget').textContent = a.max ? fmt(a.budget) : '?';
        q('max').textContent = a.max ? fmt(a.max) : '?';
        q('reserve-label').textContent = a.reserve ? `${fmt(a.reserve)} reply reserve` : '';

        const d = q('delta');
        if (a.delta === null || a.delta === 0) {
            d.textContent = '';
            d.className = 'ctxlens-delta';
        } else {
            d.textContent = `${a.delta > 0 ? '+' : '−'}${fmt(Math.abs(a.delta))}`;
            d.className = `ctxlens-delta ${a.delta > 0 ? 'up' : 'down'}`;
            d.dataset.tip = 'Change since the last send';
        }

        /* --- stacked gauge: segments scaled to the full window --- */
        const denom = a.max || (a.used + a.reserve) || 1;
        for (const seg of p.querySelectorAll('.ctxlens-gauge .ctxlens-seg')) {
            const t = a.totals[seg.dataset.cat];
            seg.style.width = `${(t / denom) * 100}%`;
            seg.style.display = t > 0 ? '' : 'none';
            seg.dataset.tip = `${CATS[seg.dataset.cat].label}: ${t} tokens`;
        }
        const res = p.querySelector('.ctxlens-reserve');
        res.style.width = `${(a.reserve / denom) * 100}%`;
        res.classList.toggle('ctxlens-reserve-hit', a.used > a.budget);
        res.dataset.tip = a.used > a.budget
            ? `Prompt overlaps the ${a.reserve}-token reply reserve — SillyTavern will trim history`
            : `${a.reserve} tokens reserved for the reply`;

        /* --- per-category rows --- */
        const maxCat = Math.max(...Object.values(a.totals), 1);
        for (const row of p.querySelectorAll('.ctxlens-row')) {
            const t = a.totals[row.dataset.cat];
            row.classList.toggle('ctxlens-row-zero', t === 0);
            row.querySelector('.ctxlens-row-bar i').style.width = `${(t / maxCat) * 100}%`;
            setNum(row.querySelector('.ctxlens-row-num b'), t);
            row.querySelector('.ctxlens-row-num em').textContent =
                `${a.used ? Math.round((t / a.used) * 100) : 0}%`;
        }

        q('sub').innerHTML = [
            a.dryRun ? '<span class="ctxlens-tag">preview</span>' : '',
            `${a.messageCount} API messages`,
            `updated ${a.when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
        ].filter(Boolean).join(' · ');

        /* --- sections --- */
        const hits = a.wi.filter(e => e.hit).length;
        p.querySelector('[data-section="wi"] .ctxlens-h-count').textContent =
            a.wi.length ? `${hits}/${a.wi.length}` : '0';
        p.querySelector('[data-section="history"] .ctxlens-h-count').textContent =
            a.visibleCount ? `${a.visibleCount - a.droppedCount}/${a.visibleCount} in context` : '';
        q('wi').innerHTML = renderWI(a);
        q('trunc').innerHTML = renderTrunc(a);
        q('strip').innerHTML = renderStrip(a);
        q('trend').innerHTML = renderTrend();
    }

    /* ------------------------------------------------------------------ */
    /* Panel construction & interaction                                    */
    /* ------------------------------------------------------------------ */

    function clampToViewport(el) {
        if (!el.classList.contains('ctxlens-open') || el.style.left === '') return;
        const r = el.getBoundingClientRect();
        const x = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
        const y = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - 40));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    }

    /* -- inspect: hover with a mouse, tap with touch ------------------- */

    function highlight(el, cat) {
        el._hlCat = cat;
        el.classList.toggle('ctxlens-hl', !!cat);
        for (const n of el.querySelectorAll('[data-cat]')) {
            n.classList.toggle('is-hl', n.dataset.cat === cat);
        }
    }

    /** Show the in-panel tooltip above (or below) `target`. */
    function showTip(el, target, extra = '') {
        const tip = el.querySelector('.ctxlens-tip');
        tip.textContent = target.dataset.tip + extra;
        tip.classList.add('show');
        el._tipTarget = target;
        const pr = el.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        const x = Math.max(6, Math.min(pr.width - tip.offsetWidth - 6,
            tr.left + tr.width / 2 - pr.left - tip.offsetWidth / 2));
        let y = tr.top - pr.top - tip.offsetHeight - 6;
        const below = y < el.querySelector('.ctxlens-head').offsetHeight;
        if (below) y = tr.bottom - pr.top + 6;
        tip.classList.toggle('below', below);
        tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }

    function hideTip(el) {
        el._tipTarget = null;
        el.querySelector('.ctxlens-tip')?.classList.remove('show');
    }

    function selectBar(el, bar) {
        highlight(el, null);
        for (const b of el.querySelectorAll('.ctxlens-bar.is-sel')) b.classList.remove('is-sel');
        bar.classList.add('is-sel');
        showTip(el, bar, ' · tap again to jump');
    }

    function clearInspect(el) {
        highlight(el, null);
        hideTip(el);
        for (const b of el.querySelectorAll('.ctxlens-bar.is-sel')) b.classList.remove('is-sel');
    }

    /** The strip bar under a horizontal position (nearest one if between bars). */
    function barAt(strip, x) {
        let best = null, bestD = Infinity;
        for (const b of strip.querySelectorAll('.ctxlens-bar')) {
            const r = b.getBoundingClientRect();
            const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
            if (d < bestD) { best = b; bestD = d; }
        }
        return best;
    }

    function jumpToMessage(i) {
        const mes = document.querySelector(`#chat .mes[mesid="${i}"]`);
        if (!mes) {
            window.toastr?.info(`Message #${i + 1} isn't loaded in the chat view.`, 'Context Lens');
            return;
        }
        // On phones the sheet covers the chat — fold it so the message is visible
        const el = panel();
        if (el && isSheet()) collapse(el, true);
        mes.scrollIntoView({ block: 'center', behavior: reducedMotion?.matches ? 'auto' : 'smooth' });
        mes.classList.remove('ctxlens-flash');
        void mes.offsetWidth; // restart the animation
        mes.classList.add('ctxlens-flash');
        setTimeout(() => mes.classList.remove('ctxlens-flash'), 1600);
    }

    function setCollapsed(el, collapsed) {
        el.classList.toggle('ctxlens-min', collapsed);
        const btn = el.querySelector('.ctxlens-collapse');
        btn.title = collapsed ? 'Expand' : 'Collapse';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed) clearInspect(el);
    }

    function collapse(el, collapsed) {
        const st = settings();
        st.collapsed = collapsed ?? !st.collapsed;
        setCollapsed(el, st.collapsed);
        ctx().saveSettingsDebounced();
    }

    function buildPanel() {
        if (panel()) return;
        const s = settings();
        const el = document.createElement('div');
        el.id = 'ctxlens_panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Context Lens');
        el.innerHTML = `
            <div class="ctxlens-head">
                <span class="ctxlens-title"><i class="fa-solid fa-chart-simple"></i> Context Lens</span>
                <span class="ctxlens-pill" title="Prompt budget used">—</span>
                <span class="ctxlens-head-btns">
                    <button type="button" class="ctxlens-btn ctxlens-collapse"><i class="fa-solid fa-chevron-up"></i></button>
                    <button type="button" class="ctxlens-btn ctxlens-close" title="Close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </span>
                <span class="ctxlens-mini"><i></i></span>
            </div>
            <div class="ctxlens-body">${skeleton()}</div>
            <div class="ctxlens-grip" title="Swipe up to fold"><span></span></div>
            <div class="ctxlens-tip" role="tooltip"></div>`;
        document.body.appendChild(el);

        if (s.x !== null && s.y !== null) {
            el.style.left = `${s.x}px`;
            el.style.top = `${s.y}px`;
            el.style.right = 'auto';
        }
        if (s.w) el.style.width = s.w;
        if (s.h) el.style.height = s.h;
        setCollapsed(el, s.collapsed);

        el.querySelector('.ctxlens-close').addEventListener('click', () => togglePanel(false));
        el.querySelector('.ctxlens-collapse').addEventListener('click', () => collapse(el));
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePanel(false); });

        // What kind of pointer started the current interaction. Hover
        // affordances are mouse-only; touch and pen get tap-to-inspect.
        let pointer = 'mouse';
        let suppressClick = false;
        el.addEventListener('pointerdown', (e) => { pointer = e.pointerType || 'mouse'; }, true);
        const touchy = () => pointer !== 'mouse';

        el.addEventListener('click', (e) => {
            if (suppressClick) { suppressClick = false; return; }

            // Collapsible sections
            const h = e.target.closest('.ctxlens-h');
            if (h) {
                const group = h.closest('.ctxlens-group');
                const collapsed = group.classList.toggle('ctxlens-collapsed');
                h.setAttribute('aria-expanded', String(!collapsed));
                settings().sections[group.dataset.section] = collapsed;
                ctx().saveSettingsDebounced();
                hideTip(el);
                return;
            }

            // Strip bars: click jumps; on touch the first tap inspects
            const bar = e.target.closest('.ctxlens-bar');
            if (bar) {
                if (!touchy() || bar.classList.contains('is-sel')) jumpToMessage(Number(bar.dataset.mes));
                else selectBar(el, bar);
                return;
            }

            if (!touchy() || e.target.closest('.ctxlens-head, .ctxlens-grip')) return;

            // Touch: tap a category or a detail to inspect it, tap again to dismiss
            const tipEl = e.target.closest('[data-tip]');
            const cat = e.target.closest('[data-cat]')?.dataset.cat ?? null;
            const same = tipEl ? tipEl === el._tipTarget : (cat && cat === el._hlCat);
            clearInspect(el);
            if (same) return;
            if (cat) highlight(el, cat);
            if (tipEl) showTip(el, tipEl);
        });

        // Mouse: hover a category anywhere → highlight it in the gauge and list
        el.addEventListener('pointerover', (e) => {
            if (e.pointerType !== 'mouse') return;
            highlight(el, e.target.closest('[data-cat]')?.dataset.cat ?? null);
            const t = e.target.closest('[data-tip]');
            if (t) showTip(el, t); else hideTip(el);
        });
        el.addEventListener('pointerleave', (e) => {
            if (e.pointerType === 'mouse') clearInspect(el);
        });
        document.addEventListener('pointerdown', (e) => {
            if (!el.contains(e.target)) clearInspect(el);
        });
        el.querySelector('.ctxlens-body').addEventListener('scroll', () => hideTip(el), { passive: true });

        // Touch: scrub a finger along the history strip to inspect messages
        const strip = el.querySelector('.ctxlens-strip');
        let scrub = null;
        strip.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse') scrub = { x: e.clientX, moved: false };
        });
        strip.addEventListener('pointermove', (e) => {
            if (!scrub) return;
            if (!scrub.moved && Math.abs(e.clientX - scrub.x) < 8) return;
            scrub.moved = true;
            const bar = barAt(strip, e.clientX);
            if (bar && !bar.classList.contains('is-sel')) selectBar(el, bar);
        });
        strip.addEventListener('pointerup', () => {
            if (scrub?.moved) {
                suppressClick = true; // the lift ends a scrub, it isn't a tap
                setTimeout(() => { suppressClick = false; }, 350);
            }
            scrub = null;
        });
        strip.addEventListener('pointercancel', () => { scrub = null; });

        // Header: drag to move on desktop; on phones tap or swipe to fold/unfold
        const head = el.querySelector('.ctxlens-head');
        let drag = null;
        let swipe = null;
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            el.classList.remove('ctxlens-dragging');
            const st = settings();
            st.x = el.offsetLeft;
            st.y = el.offsetTop;
            ctx().saveSettingsDebounced();
        };
        const endSwipe = (e) => {
            if (!swipe) return false;
            const dy = e.clientY - swipe.y;
            swipe = null;
            if (Math.abs(dy) < 10) collapse(el);    // tap toggles
            else collapse(el, dy < 0);              // swipe up folds, down unfolds
            return true;
        };
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button') || e.button !== 0) return;
            if (isSheet()) { swipe = { y: e.clientY }; return; }
            drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
            el.classList.add('ctxlens-dragging');
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const maxX = window.innerWidth - el.offsetWidth;
            const maxY = window.innerHeight - 40;
            el.style.left = `${Math.min(maxX, Math.max(0, e.clientX - drag.dx))}px`;
            el.style.top = `${Math.min(maxY, Math.max(0, e.clientY - drag.dy))}px`;
            el.style.right = 'auto';
        });
        head.addEventListener('pointerup', (e) => { if (!endSwipe(e)) endDrag(); });
        head.addEventListener('pointercancel', () => { swipe = null; endDrag(); });
        head.addEventListener('dblclick', (e) => {
            if (!isSheet() && !e.target.closest('button')) collapse(el);
        });

        // Bottom grip of the phone sheet: tap or swipe up to fold
        const grip = el.querySelector('.ctxlens-grip');
        let gripY = null;
        grip.addEventListener('pointerdown', (e) => { gripY = e.clientY; });
        grip.addEventListener('pointerup', (e) => {
            if (gripY !== null && e.clientY - gripY < 10) collapse(el, true);
            gripY = null;
        });
        grip.addEventListener('pointercancel', () => { gripY = null; });

        // Persist size after the user drags the resize handle
        if (window.ResizeObserver) {
            let t;
            new ResizeObserver(() => {
                clearTimeout(t);
                t = setTimeout(() => {
                    if (isSheet() || (!el.style.width && !el.style.height)) return;
                    const st = settings();
                    st.w = el.style.width || null;
                    st.h = el.style.height || null;
                    ctx().saveSettingsDebounced();
                }, 300);
            }).observe(el);
        }

        window.addEventListener('resize', () => { clampToViewport(el); hideTip(el); });
        sheetQuery?.addEventListener?.('change', () => { clampToViewport(el); clearInspect(el); });
    }

    function togglePanel(force) {
        buildPanel();
        const s = settings();
        s.open = force ?? !s.open;
        const el = panel();
        el.classList.toggle('ctxlens-open', s.open);
        ctx().saveSettingsDebounced();
        if (s.open) {
            clampToViewport(el);
            render();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Wiring                                                              */
    /* ------------------------------------------------------------------ */

    function addLauncher() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('ctxlens_launcher')) return;
        const item = document.createElement('div');
        item.id = 'ctxlens_launcher';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `<div class="fa-solid fa-chart-simple extensionsMenuExtensionButton"></div>Context Lens`;
        item.addEventListener('click', () => togglePanel());
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
        });
        menu.appendChild(item);
    }

    function registerCommand() {
        const c = ctx();
        const callback = () => { togglePanel(); return ''; };
        try {
            if (c.SlashCommandParser && c.SlashCommand) {
                c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                    name: 'contextlens',
                    aliases: ['ctxlens'],
                    callback,
                    helpString: 'Toggle the Context Lens panel.',
                }));
            } else if (typeof c.registerSlashCommand === 'function') {
                c.registerSlashCommand('contextlens', callback, ['ctxlens'], ' – toggle the Context Lens panel', true, true);
            }
        } catch (e) {
            console.warn('[Context Lens] could not register /contextlens', e);
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;
        const { eventSource, event_types } = ctx();

        eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
            lastActivatedWI = Array.isArray(entries) ? entries : [];
        });

        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
            if (!data?.chat?.length) return;
            // Dry runs fire for token previews — analyze those too so the
            // panel stays live without needing a real generation.
            queueAnalyze(data.chat, data.dryRun);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            lastAnalysis = null;
            lastActivatedWI = [];
            trend = [];
            render();
        });

        addLauncher();
        registerCommand();
        if (settings().open) togglePanel(true);
        console.log('[Context Lens] ready');
    }

    // Wait for the app to be ready
    if (window.SillyTavern?.getContext) {
        const { eventSource, event_types } = ctx();
        eventSource.once(event_types.APP_READY, init);
        // If APP_READY already fired (extensions load late), init directly
        if (document.getElementById('extensionsMenu')) init();
    }
})();
