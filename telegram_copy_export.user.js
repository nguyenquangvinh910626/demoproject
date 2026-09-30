// ==UserScript==
// @name         Telegram Web - Copy & Export Search Results
// @namespace    https://github.com/nguyenquangvinh910626/demoproject
// @version      1.0.1
// @description  Add Copy/Export buttons to Telegram search-result messages and export results to XLSX.
// @match        https://web.telegram.org/*
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        wrapper: '.bubble-content-wrapper',
        bubble: '.bubble',
        message: '.bubble-content .message',
        book: 'a.anchor-url[href*="start=book_"]',
        pages: '.reply-markup .reply-markup-button',
        timeout: 9000,
        poll: 100,
        maxNavigation: 50
    };

    let exporting = false;
    let scanQueued = false;

    GM_addStyle(`
        .bubble-content-wrapper{position:relative!important}
        .tm-ce-actions{position:absolute;top:8px;right:8px;z-index:10000;display:flex;flex-direction:column;gap:6px;opacity:0;transform:translateX(2px);transition:opacity .15s,transform .15s;pointer-events:none}
        .bubble:hover .tm-ce-actions,.tm-ce-actions:hover{opacity:1;transform:none}
        .tm-ce-actions button{pointer-events:auto;width:34px;height:34px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:17px;line-height:1;background:rgba(255,255,255,.96);color:#333;box-shadow:0 1px 5px rgba(0,0,0,.22)}
        .tm-ce-actions button:hover{transform:scale(1.08);background:#fff}
        .tm-ce-copy.copied{background:#38a169;color:#fff}
        .tm-ce-modal{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;background:rgba(0,0,0,.45);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
        .tm-ce-modal.open{display:flex}
        .tm-ce-dialog{width:min(460px,100%);max-height:92vh;overflow:auto;padding:24px;box-sizing:border-box;border-radius:16px;background:#fff;color:#222;box-shadow:0 18px 60px rgba(0,0,0,.32)}
        .tm-ce-dialog h2{margin:0 0 8px;font-size:22px}.tm-ce-sub{margin:0 0 18px;color:#666;font-size:13px;line-height:1.45}
        .tm-ce-field{margin-bottom:14px}.tm-ce-field label{display:block;margin-bottom:6px;font-size:13px;font-weight:600}.tm-ce-field input{width:100%;height:42px;padding:0 12px;box-sizing:border-box;border:1px solid #d7d7d7;border-radius:10px;font-size:16px}
        .tm-ce-info{margin:4px 0 16px;padding:10px 12px;border-radius:10px;background:#f5f6f8;color:#555;font-size:13px}
        .tm-ce-progress{display:none;margin-top:14px}.tm-ce-progress.show{display:block}.tm-ce-plabel{display:flex;justify-content:space-between;margin-bottom:7px;font-size:13px;color:#555}.tm-ce-track{height:8px;overflow:hidden;border-radius:999px;background:#e9eaed}.tm-ce-bar{width:0;height:100%;background:#2f80ed;transition:width .18s}
        .tm-ce-status{min-height:38px;margin-top:10px;font-size:13px;line-height:1.45;white-space:pre-wrap;color:#555}.tm-ce-error{color:#c0392b}.tm-ce-success{color:#26834a}
        .tm-ce-actions-row{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.tm-ce-actions-row button{min-width:94px;height:40px;padding:0 16px;border:0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer}.tm-ce-cancel{background:#eceef1;color:#333}.tm-ce-submit{background:#2f80ed;color:#fff}.tm-ce-actions-row button:disabled{opacity:.55;cursor:default}
    `);

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const text = v => String(v ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\r?\n[ \t]*/g, '\n').trim();

    async function waitFor(fn, timeout = CFG.timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try { const value = fn(); if (value) return value; } catch (_) {}
            await sleep(CFG.poll);
        }
        return null;
    }

    function getBubble(mid) {
        return mid ? document.querySelector(`.bubble[data-mid="${CSS.escape(String(mid))}"]`) : null;
    }

    function getHeader(bubble) {
        const raw = text(bubble?.querySelector(CFG.message)?.innerText || bubble?.querySelector('.bubble-content')?.innerText || '');
        const patterns = [
            /(?:Kết quả|结果|Results?)\s*(\d+)\s*[-–—]\s*(\d+).*?(?:trong tổng số|共|of|total)\s*(\d+)/i,
            /(\d+)\s*[-–—]\s*(\d+).*?(?:trong tổng số|共|of|total)\s*(\d+)/i
        ];
        for (const re of patterns) {
            const m = raw.match(re);
            if (m) {
                const start = +m[1], end = +m[2], total = +m[3];
                const pageSize = Math.max(1, end - start + 1);
                return { start, end, total, page: Math.floor((start - 1) / pageSize) + 1, totalPages: Math.ceil(total / pageSize) };
            }
        }
        return null;
    }

    function pageLabel(btn) {
        return text(btn?.querySelector('.reply-markup-button-text')?.innerText || btn?.innerText || '');
    }

    function findPageButton(bubble, page) {
        return [...(bubble?.querySelectorAll(CFG.pages) || [])].find(btn => /^\d+$/.test(pageLabel(btn)) && +pageLabel(btn) === page) || null;
    }

    function parseLength(value) {
        const s = text(value).replace(/,/g, '');
        const wan = s.match(/([0-9]+(?:\.[0-9]+)?)\s*万/);
        if (wan) return Math.round(+wan[1] * 10000);
        const n = s.match(/[0-9]+(?:\.[0-9]+)?/);
        return n ? +n[0] : '';
    }

    function parseMeta(value) {
        const parts = text(value).replace(/^[^A-Za-z0-9·]*·?/, '').split('·').map(text).filter(Boolean);
        if (parts.length < 4) return null;
        return { Type: parts[0], Size: parts[1], Length: parseLength(parts[2]), Score: parts[3] };
    }

    function metaForLink(link) {
        let node = link.nextElementSibling;
        for (let i = 0; i < 4 && node; i++, node = node.nextElementSibling) {
            if (node.matches?.('code.monospace-text')) {
                const meta = parseMeta(node.innerText);
                if (meta) return meta;
            }
        }
        const root = link.closest('.translatable-message') || link.parentElement;
        const links = [...(root?.querySelectorAll(CFG.book) || [])];
        const codes = [...(root?.querySelectorAll('code.monospace-text') || [])];
        const i = links.indexOf(link);
        return i >= 0 && codes[i] ? parseMeta(codes[i].innerText) : null;
    }

    function parseResults(bubble, page) {
        const rows = [], warnings = [];
        [...(bubble?.querySelectorAll(CFG.book) || [])].forEach((link, i) => {
            const meta = metaForLink(link);
            if (!meta) { warnings.push(`Page ${page}, result ${i + 1}: metadata parse failed.`); return; }
            rows.push({
                Page: page,
                Name: text(link.innerText),
                Type: meta.Type,
                Size: meta.Size,
                Length: meta.Length,
                Score: meta.Score,
                URL: link.href || link.getAttribute('href') || ''
            });
        });
        return { rows, warnings };
    }

    async function goToPage(mid, target) {
        let bubble = getBubble(mid), info = getHeader(bubble);
        if (!info) throw new Error('Cannot read current search page.');
        if (info.page === target) return info;

        for (let step = 0; step < CFG.maxNavigation; step++) {
            bubble = getBubble(mid); info = getHeader(bubble);
            if (!info) throw new Error('Cannot read search page after navigation.');
            if (info.page === target) return info;

            const direction = target > info.page ? 1 : -1;
            let button = findPageButton(bubble, info.page + direction);
            if (!button) {
                const numeric = [...bubble.querySelectorAll(CFG.pages)].map(b => ({ b, n: +pageLabel(b) })).filter(x => /^\d+$/.test(pageLabel(x.b)) && Number.isInteger(x.n));
                button = numeric.find(x => direction > 0 ? x.n > info.page && x.n <= target : x.n < info.page && x.n >= target)?.b || null;
                if (!button) button = numeric.find(x => direction > 0 ? x.n > info.page : x.n < info.page)?.b || null;
            }
            if (!button && target === info.totalPages) {
                button = [...bubble.querySelectorAll(CFG.pages)].find(b => new RegExp(`(?:…|\.\.\.)${info.totalPages}$`).test(pageLabel(b))) || null;
            }
            if (!button) throw new Error(`Cannot find pagination button from page ${info.page} to ${target}.`);

            const oldStart = info.start;
            button.click();
            const changed = await waitFor(() => {
                const next = getHeader(getBubble(mid));
                return next && next.start !== oldStart ? next : null;
            });
            if (!changed) throw new Error(`Telegram did not render the next page from page ${info.page}.`);
        }
        throw new Error(`Navigation exceeded ${CFG.maxNavigation} steps.`);
    }

    function downloadXlsx(rows, startPage, endPage) {
        if (!rows.length) throw new Error('No records found.');
        const headers = ['Page', 'Name', 'Type', 'Size', 'Length', 'Score', 'URL'];
        const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
        ws['!autofilter'] = { ref: ws['!ref'] };
        ws['!cols'] = [{ wch: 8 }, { wch: 55 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 85 }];
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let r = 1; r <= range.e.r; r++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c: 6 })];
            if (cell?.v) cell.l = { Target: String(cell.v), Tooltip: 'Open Telegram link' };
        }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Books');
        const file = `telegram_export_p${String(startPage).padStart(2, '0')}-p${String(endPage).padStart(2, '0')}.xlsx`;
        XLSX.writeFile(wb, file);
        return file;
    }

    function ensureModal() {
        let modal = document.getElementById('tm-ce-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'tm-ce-modal'; modal.className = 'tm-ce-modal';
        modal.innerHTML = `
            <div class="tm-ce-dialog" role="dialog" aria-modal="true">
                <h2>Export search results</h2>
                <p class="tm-ce-sub">Pages will be visited automatically. XLSX: Page, Name, Type, Size, Length, Score, URL.</p>
                <div class="tm-ce-field"><label>Start page</label><input id="tm-ce-start" type="number" min="1" step="1"></div>
                <div class="tm-ce-field"><label>End page</label><input id="tm-ce-end" type="number" min="1" step="1"></div>
                <div class="tm-ce-info" id="tm-ce-info"></div>
                <div class="tm-ce-progress" id="tm-ce-progress"><div class="tm-ce-plabel"><span id="tm-ce-page">Page</span><span id="tm-ce-count">0 rows</span></div><div class="tm-ce-track"><div class="tm-ce-bar" id="tm-ce-bar"></div></div></div>
                <div class="tm-ce-status" id="tm-ce-status"></div>
                <div class="tm-ce-actions-row"><button class="tm-ce-cancel" id="tm-ce-cancel">Cancel</button><button class="tm-ce-submit" id="tm-ce-submit">Export XLSX</button></div>
            </div>`;
        document.body.appendChild(modal);
        return modal;
    }

    function openExport(wrapper) {
        if (exporting) return;
        const bubble = wrapper.closest(CFG.bubble), mid = bubble?.dataset.mid, info = getHeader(bubble);
        if (!mid || !info) return alert('Cannot read search-result page information.');

        const modal = ensureModal();
        const start = modal.querySelector('#tm-ce-start'), end = modal.querySelector('#tm-ce-end'), infoEl = modal.querySelector('#tm-ce-info');
        const progress = modal.querySelector('#tm-ce-progress'), bar = modal.querySelector('#tm-ce-bar'), pageEl = modal.querySelector('#tm-ce-page'), countEl = modal.querySelector('#tm-ce-count'), status = modal.querySelector('#tm-ce-status');
        const cancel = modal.querySelector('#tm-ce-cancel'), submit = modal.querySelector('#tm-ce-submit');
        start.value = info.page; end.value = info.totalPages; infoEl.textContent = `Current page: ${info.page} / ${info.totalPages} · Results: ${info.total}`;
        progress.classList.remove('show'); bar.style.width = '0%'; pageEl.textContent = `Page ${info.page}`; countEl.textContent = '0 rows'; status.textContent = ''; status.className = 'tm-ce-status'; submit.textContent = 'Export XLSX'; cancel.disabled = false; submit.disabled = false; modal.classList.add('open'); start.focus();

        cancel.onclick = () => { if (exporting) { exporting = false; status.textContent = 'Cancelling...'; cancel.disabled = true; submit.disabled = true; } else modal.classList.remove('open'); };

        submit.onclick = async () => {
            if (exporting) return;
            const a = Number(start.value), b = Number(end.value);
            if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > info.totalPages) { status.textContent = `Page range must be between 1 and ${info.totalPages}.`; status.className = 'tm-ce-status tm-ce-error'; return; }
            exporting = true; start.disabled = end.disabled = submit.disabled = false; start.disabled = end.disabled = true; cancel.disabled = false; submit.disabled = true; progress.classList.add('show'); status.textContent = 'Preparing...';
            const original = getHeader(getBubble(mid))?.page || info.page; const rows = []; const warnings = []; let lastPage = original;
            try {
                for (let page = a; page <= b; page++) {
                    if (!exporting) throw new Error('__CANCELLED__');
                    if (lastPage !== page) { status.textContent = `Going to page ${page}...`; await goToPage(mid, page); lastPage = page; }
                    const current = getBubble(mid); if (!current) throw new Error('Search-result message disappeared.');
                    const parsed = parseResults(current, page); rows.push(...parsed.rows); warnings.push(...parsed.warnings);
                    const done = page - a + 1, total = b - a + 1; pageEl.textContent = `Page ${page} / ${b}`; countEl.textContent = `${rows.length} rows`; bar.style.width = `${Math.round(done / total * 100)}%`; status.textContent = `Collected page ${page}.${warnings.length ? ` Warnings: ${warnings.length}` : ''}`;
                    if (page < b) { await goToPage(mid, page + 1); lastPage = page + 1; }
                }
                if (!exporting) throw new Error('__CANCELLED__');
                const file = downloadXlsx(rows, a, b); status.textContent = `Completed.\n${rows.length} rows\nFile: ${file}${warnings.length ? `\nWarnings: ${warnings.length}` : ''}`; status.className = 'tm-ce-status tm-ce-success'; bar.style.width = '100%'; pageEl.textContent = 'Done'; submit.disabled = false; submit.textContent = 'Close'; submit.onclick = () => modal.classList.remove('open');
            } catch (err) {
                status.textContent = err?.message === '__CANCELLED__' ? 'Export cancelled.' : `Export failed:\n${err?.message || err}`; status.className = err?.message === '__CANCELLED__' ? 'tm-ce-status' : 'tm-ce-status tm-ce-error'; submit.disabled = false;
            } finally {
                try { const now = getHeader(getBubble(mid)); if (now && now.page !== original) { status.textContent += '\nRestoring original page...'; await goToPage(mid, original); } } catch (_) { status.textContent += '\nCould not restore the original page.'; }
                exporting = false; start.disabled = end.disabled = false; cancel.disabled = false;
            }
        };

        [start, end].forEach(input => input.onkeydown = e => { if (e.key === 'Enter' && !exporting) { e.preventDefault(); submit.click(); } });
    }

    async function copyContent(wrapper, button) {
        const value = text(wrapper.querySelector('.bubble-content')?.innerText || '');
        if (!value) return;
        try { await navigator.clipboard.writeText(value); } catch (_) { const ta = document.createElement('textarea'); ta.value = value; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        button.textContent = '✓'; button.classList.add('copied'); setTimeout(() => { button.textContent = '📋'; button.classList.remove('copied'); }, 1000);
    }

    function addActions(wrapper) {
        if (!(wrapper instanceof HTMLElement)) return;
        let group = wrapper.querySelector('.tm-ce-actions');
        if (!group) {
            group = document.createElement('div'); group.className = 'tm-ce-actions';
            const copy = document.createElement('button'); copy.className = 'tm-ce-copy'; copy.type = 'button'; copy.textContent = '📋'; copy.title = 'Copy message'; copy.onclick = e => { e.preventDefault(); e.stopPropagation(); copyContent(wrapper, copy); };
            group.appendChild(copy); wrapper.appendChild(group);
        }
        if (wrapper.querySelector(CFG.book) && wrapper.querySelector('.reply-markup') && !group.querySelector('.tm-ce-export')) {
            const exp = document.createElement('button'); exp.className = 'tm-ce-export'; exp.type = 'button'; exp.textContent = '📤'; exp.title = 'Export search results to XLSX'; exp.onclick = e => { e.preventDefault(); e.stopPropagation(); openExport(wrapper); }; group.appendChild(exp);
        }
    }

    function scan() { document.querySelectorAll(CFG.wrapper).forEach(addActions); }
    function scheduleScan() { if (scanQueued) return; scanQueued = true; requestAnimationFrame(() => { scanQueued = false; scan(); }); }

    document.addEventListener('keydown', e => { const modal = document.getElementById('tm-ce-modal'); if (e.key === 'Escape' && modal?.classList.contains('open') && !exporting) modal.classList.remove('open'); });
    document.addEventListener('click', e => { const modal = document.getElementById('tm-ce-modal'); if (e.target === modal && modal.classList.contains('open') && !exporting) modal.classList.remove('open'); });
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scan();
    console.log('[Telegram Copy & Export] Loaded v1.0.1');
})();
