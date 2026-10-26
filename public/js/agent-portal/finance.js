(() => {
    'use strict';
    const root = document.querySelector('.agent-ledger');
    if (!root) return;
    const search = root.querySelector('[data-ledger-search]');
    const entries = Array.from(root.querySelectorAll('[data-ledger-entry]'));
    const pagination = root.querySelector('[data-ledger-pagination]');
    const more = root.querySelector('[data-ledger-more]');
    const progress = root.querySelector('[data-ledger-progress]');
    const empty = root.querySelector('[data-ledger-empty]');
    const normalize = value => String(value).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').toLocaleLowerCase('ar').trim();
    let limit = 20;
    const render = () => {
        const terms = normalize(search.value).split(/\s+/).filter(Boolean);
        let matches = 0;
        entries.forEach(entry => {
            const text = normalize(entry.dataset.ledgerSearchText);
            const match = terms.every(term => text.includes(term));
            entry.hidden = !match || ++matches > limit;
            if (entry.hidden) entry.open = false;
        });
        const shown = Math.min(limit, matches);
        empty.hidden = matches > 0 || entries.length === 0;
        pagination.hidden = entries.length === 0;
        progress.textContent = `عرض ${shown} من ${matches} حركة محمّلة`;
        more.hidden = shown >= matches;
    };
    search.addEventListener('input', () => { limit = 20; render(); });
    more.addEventListener('click', () => { limit += 20; render(); });
    render();
})();
