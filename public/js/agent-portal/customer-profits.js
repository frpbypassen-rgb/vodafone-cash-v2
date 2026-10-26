(() => {
    'use strict';
    const root = document.querySelector('.agent-profits');
    if (!root) return;
    const search = root.querySelector('[data-profit-search]');
    const sort = root.querySelector('[data-profit-sort]');
    const list = root.querySelector('[data-profit-list]');
    const rows = Array.from(root.querySelectorAll('[data-profit-row]'));
    const empty = root.querySelector('[data-profit-empty]');
    const footer = root.querySelector('[data-profit-footer]');
    const more = root.querySelector('[data-profit-more]');
    const progress = root.querySelector('[data-profit-progress]');
    const normalize = text => String(text).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').toLocaleLowerCase('ar').trim();
    let limit = 20;
    const render = () => {
        const terms = normalize(search.value).split(/\s+/).filter(Boolean);
        const ordered = rows.slice().sort((a, b) => (sort.value === 'profit' ? Number(b.dataset.profit) - Number(a.dataset.profit) : 0) || a.dataset.name.localeCompare(b.dataset.name, 'ar'));
        let count = 0;
        ordered.forEach(row => {
            const name = normalize(row.dataset.name);
            const match = terms.every(term => name.includes(term));
            row.hidden = !match || ++count > limit;
            if (row.hidden) row.open = false;
            list.append(row);
        });
        empty.hidden = count > 0;
        empty.textContent = rows.length ? 'لا يوجد عميل مطابق للبحث.' : 'لا توجد أرباح للعملاء في الفترة المحددة.';
        footer.hidden = count === 0;
        more.hidden = count <= limit;
        progress.textContent = `عرض ${Math.min(limit, count)} من ${count} عميل`;
    };
    search.addEventListener('input', () => { limit = 20; render(); });
    sort.addEventListener('change', () => { limit = 20; render(); });
    more.addEventListener('click', () => { limit += 20; render(); });
    render();
})();
