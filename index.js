/**
 * Context Lens — a context-window dashboard for SillyTavern (Chat Completion APIs)
 *
 * What it does:
 *  - Hooks CHAT_COMPLETION_PROMPT_READY to inspect the exact messages sent to the API
 *  - Attributes tokens to: main prompt, character card, world info, chat history,
 *    author's note / extension prompts, and per-message overhead
 *  - Shows a stacked token-budget gauge, a fill donut, per-category bars,
 *    active world info entries (with trigger keys), a per-message history strip,
 *    and the truncation line ("oldest message still in context")
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
        wi:       { label: 'World info',       color: '#FFB347' },
        history:  { label: 'Chat history',     color: '#4ECDC4' },
        note:     { label: "Author's note +",  color: '#A8E05F' },
        overhead: { label: 'Other / overhead', color: '#7E8799' },
    };

    const PER_MESSAGE_OVERHEAD = 3; // rough ChatML wrapper cost per message

    /* ------------------------------------------------------------------ */
    /* State                                                               */
    /* ------------------------------------------------------------------ */

    let lastActivatedWI = [];   // entries captured from WORLD_INFO_ACTIVATED
    let lastAnalysis = null;    // result of the most recent prompt analysis
    let analyzing = false;

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    const ctx = () => SillyTavern.getContext();

    function settings() {
        const es = ctx().extensionSettings;
        es[MODULE] = es[MODULE] || { x: null, y: null, open: false };
        return es[MODULE];
    }

    async function tokens(text) {
        if (!text) return 0;
        const c = ctx();
        try {
            if (typeof c.getTokenCountAsync === 'function') return await c.getTokenCountAsync(text);
            if (typeof c.getTokenCount === 'function') return c.getTokenCount(text);
        } catch (e) { /* fall through */ }
        return Math.ceil(text.length / 3.5); // crude fallback
    }

    function maxContext() {
        const c = ctx();
        return c.chatCompletionSettings?.openai_max_context
            ?? c.maxContext
            ?? 0;
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

    function fmt(n) {
        return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, m =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
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
                             char.mes_example, char.data?.system_prompt]) {
                const text = sub(f)?.trim();
                if (text) sources.push({ cat: 'card', text });
            }
        }

        // Persona description counts toward the card bucket too
        const persona = sub(c.powerUserSettings?.persona_description)?.trim();
        if (persona) sources.push({ cat: 'card', text: persona });

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

    /**
     * Analyze the assembled chat-completion prompt.
     * @param {Array<{role:string, content:any, name?:string}>} chat
     */
    async function analyze(chat) {
        if (analyzing) return;
        analyzing = true;
        try {
            const c = ctx();
            const sources = knownSources();

            const totals = { main: 0, card: 0, wi: 0, history: 0, note: 0, overhead: 0 };
            const wiHits = new Map(); // source text -> seen

            // Pre-render chat history texts for truncation matching
            const histTexts = (c.chat || []).map(m => sub(m.mes ?? '').trim());
            let oldestIncluded = null;
            const includedHistIdx = new Set();

            let firstSystemSeen = false;

            for (const m of chat) {
                let text = msgText(m.content);
                totals.overhead += PER_MESSAGE_OVERHEAD;
                if (!text) continue;

                // 1. Claim known sources embedded in this message
                for (const s of sources) {
                    if (s.text.length >= 8 && text.includes(s.text)) {
                        totals[s.cat] += await tokens(s.text);
                        if (s.cat === 'wi') wiHits.set(s.text, true);
                        text = text.replace(s.text, '\u0000');
                    }
                }
                const remainder = text.replaceAll('\u0000', '').trim();
                if (!remainder) continue;
                const remTok = await tokens(remainder);

                // 2. Categorize the remainder
                if (m.role === 'user' || m.role === 'assistant') {
                    totals.history += remTok;
                    // Truncation tracking: which real chat message is this?
                    for (let i = 0; i < histTexts.length; i++) {
                        const h = histTexts[i];
                        if (h && (remainder === h || remainder.includes(h))) {
                            includedHistIdx.add(i);
                            if (oldestIncluded === null || i < oldestIncluded) oldestIncluded = i;
                        }
                    }
                } else if (!firstSystemSeen) {
                    firstSystemSeen = true;
                    totals.main += remTok;
                } else {
                    totals.overhead += remTok;
                }
            }

            // Per-message token strip for the visible tail of the chat
            const stripWindow = 40;
            const start = Math.max(0, histTexts.length - stripWindow);
            const strip = [];
            for (let i = start; i < histTexts.length; i++) {
                strip.push({
                    index: i,
                    isUser: !!c.chat[i]?.is_user,
                    included: includedHistIdx.has(i),
                    tokens: await tokens(histTexts[i]),
                });
            }

            const used = Object.values(totals).reduce((a, b) => a + b, 0);

            lastAnalysis = {
                totals,
                used,
                max: maxContext(),
                messageCount: chat.length,
                wi: lastActivatedWI.map(e => ({
                    comment: e.comment || e.key?.join?.(', ') || '(untitled)',
                    keys: Array.isArray(e.key) ? e.key : [],
                    constant: !!e.constant,
                    world: e.world || '',
                    hit: wiHits.has(sub(e.content)?.trim()),
                })),
                oldestIncluded,
                droppedCount: oldestIncluded === null
                    ? (histTexts.length ? histTexts.length : 0)
                    : oldestIncluded,
                historyLen: histTexts.length,
                strip,
                when: new Date(),
            };
            render();
        } finally {
            analyzing = false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                           */
    /* ------------------------------------------------------------------ */

    function panel() { return document.getElementById('ctxlens_panel'); }

    function render() {
        const p = panel();
        if (!p || !settings().open) return;
        const a = lastAnalysis;
        const body = p.querySelector('.ctxlens-body');

        if (!a) {
            body.innerHTML = `<div class="ctxlens-empty">
                Send a message (or trigger a generation) and the assembled
                prompt will be analyzed here.
            </div>`;
            return;
        }

        const max = a.max || a.used;
        const pct = max ? Math.min(100, (a.used / max) * 100) : 0;

        /* --- stacked gauge segments --- */
        const segs = Object.entries(CATS)
            .filter(([k]) => a.totals[k] > 0)
            .map(([k, def]) => {
                const w = max ? (a.totals[k] / max) * 100 : 0;
                return `<div class="ctxlens-seg" title="${def.label}: ${a.totals[k]} tokens"
                             style="width:${w}%;background:${def.color}"></div>`;
            }).join('');

        /* --- legend / per-category bars --- */
        const maxCat = Math.max(...Object.values(a.totals), 1);
        const rows = Object.entries(CATS).map(([k, def]) => {
            const t = a.totals[k];
            const share = a.used ? Math.round((t / a.used) * 100) : 0;
            return `<div class="ctxlens-row">
                <span class="ctxlens-dot" style="background:${def.color}"></span>
                <span class="ctxlens-row-label">${def.label}</span>
                <span class="ctxlens-row-bar"><i style="width:${(t / maxCat) * 100}%;background:${def.color}"></i></span>
                <span class="ctxlens-row-num">${fmt(t)} <em>${share}%</em></span>
            </div>`;
        }).join('');

        /* --- world info list --- */
        const wiList = a.wi.length
            ? a.wi.map(e => `
                <div class="ctxlens-wi ${e.hit ? '' : 'ctxlens-wi-miss'}">
                    <span class="ctxlens-wi-name">${esc(e.comment)}</span>
                    <span class="ctxlens-wi-keys">${e.constant
                        ? '<span class="ctxlens-chip ctxlens-chip-const">constant</span>'
                        : e.keys.map(k => `<span class="ctxlens-chip">${esc(k)}</span>`).join('')}
                    </span>
                </div>`).join('')
            : `<div class="ctxlens-muted">No lorebook entries fired this turn.</div>`;

        /* --- truncation line --- */
        let truncHtml;
        if (a.historyLen === 0) {
            truncHtml = `<div class="ctxlens-muted">Chat is empty.</div>`;
        } else if (a.droppedCount === 0) {
            truncHtml = `<div class="ctxlens-trunc ok">✓ Entire chat history fits in context.</div>`;
        } else {
            truncHtml = `<div class="ctxlens-trunc warn">
                ⚠ Oldest message in context: <b>#${a.oldestIncluded + 1}</b> —
                <b>${a.droppedCount}</b> older message${a.droppedCount === 1 ? '' : 's'} fell out.
            </div>`;
        }

        /* --- per-message strip --- */
        const maxStripTok = Math.max(...a.strip.map(s => s.tokens), 1);
        const stripHtml = a.strip.map(s => `
            <div class="ctxlens-bar ${s.included ? 'in' : 'out'} ${s.isUser ? 'user' : 'ai'}"
                 title="#${s.index + 1} · ${s.tokens} tok · ${s.included ? 'in context' : 'dropped'}"
                 style="height:${Math.max(8, (s.tokens / maxStripTok) * 100)}%"></div>`).join('');

        body.innerHTML = `
            <div class="ctxlens-top">
                <div class="ctxlens-donut" style="--pct:${pct};--ring:${pct > 92 ? '#FF6B6B' : pct > 75 ? '#FFB347' : '#4ECDC4'}">
                    <div class="ctxlens-donut-hole">
                        <b>${Math.round(pct)}%</b><span>full</span>
                    </div>
                </div>
                <div class="ctxlens-top-stats">
                    <div class="ctxlens-big">${fmt(a.used)} <span>/ ${max ? fmt(max) : '?'} tokens</span></div>
                    <div class="ctxlens-gauge">${segs}<div class="ctxlens-free"></div></div>
                    <div class="ctxlens-sub">${a.messageCount} API messages · updated ${a.when.toLocaleTimeString()}</div>
                </div>
            </div>

            <div class="ctxlens-section">${rows}</div>

            <div class="ctxlens-h">World info <span>(${a.wi.length})</span></div>
            <div class="ctxlens-section">${wiList}</div>

            <div class="ctxlens-h">Chat history</div>
            <div class="ctxlens-section">
                ${truncHtml}
                <div class="ctxlens-strip">${stripHtml}</div>
                <div class="ctxlens-strip-legend">
                    <span><i class="sw user"></i>you</span>
                    <span><i class="sw ai"></i>AI</span>
                    <span><i class="sw out"></i>dropped</span>
                </div>
            </div>`;
    }

    /* ------------------------------------------------------------------ */
    /* Panel construction & dragging                                       */
    /* ------------------------------------------------------------------ */

    function buildPanel() {
        if (panel()) return;
        const el = document.createElement('div');
        el.id = 'ctxlens_panel';
        el.innerHTML = `
            <div class="ctxlens-head">
                <span class="ctxlens-title"><i class="fa-solid fa-chart-simple"></i> Context Lens</span>
                <span class="ctxlens-close" title="Close">×</span>
            </div>
            <div class="ctxlens-body"></div>`;
        document.body.appendChild(el);

        const s = settings();
        if (s.x !== null && s.y !== null) {
            el.style.left = `${s.x}px`;
            el.style.top = `${s.y}px`;
            el.style.right = 'auto';
        }

        el.querySelector('.ctxlens-close').addEventListener('click', () => togglePanel(false));

        // Drag by header
        const head = el.querySelector('.ctxlens-head');
        let drag = null;
        head.addEventListener('pointerdown', (e) => {
            if (e.target.classList.contains('ctxlens-close')) return;
            drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!drag) return;
            el.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
            el.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
            el.style.right = 'auto';
        });
        head.addEventListener('pointerup', () => {
            if (!drag) return;
            drag = null;
            const st = settings();
            st.x = el.offsetLeft;
            st.y = el.offsetTop;
            ctx().saveSettingsDebounced();
        });
    }

    function togglePanel(force) {
        buildPanel();
        const s = settings();
        s.open = force ?? !s.open;
        panel().classList.toggle('ctxlens-open', s.open);
        ctx().saveSettingsDebounced();
        if (s.open) render();
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
        menu.appendChild(item);
    }

    function init() {
        const { eventSource, event_types } = ctx();

        eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
            lastActivatedWI = Array.isArray(entries) ? entries : [];
        });

        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
            if (!data?.chat?.length) return;
            // Dry runs fire for token previews — analyze those too so the
            // panel stays live without needing a real generation.
            analyze(data.chat);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            lastAnalysis = null;
            lastActivatedWI = [];
            render();
        });

        addLauncher();
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
