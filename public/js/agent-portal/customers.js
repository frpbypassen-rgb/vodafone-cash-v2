(() => {
    'use strict';
    const root = document.querySelector('.agent-customers');
    if (!root) return;
    const search = root.querySelector('[data-customer-search]');
    const filter = root.querySelector('[data-customer-filter]');
    const rows = Array.from(root.querySelectorAll('[data-customer-row]'));
    const empty = root.querySelector('[data-customer-empty]');
    const footer = root.querySelector('[data-customer-footer]');
    const more = root.querySelector('[data-customer-more]');
    const progress = root.querySelector('[data-customer-progress]');
    const normalize = value => String(value).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).toLocaleLowerCase('ar').trim();
    let limit = 20;
    const render = () => {
        const terms = normalize(search.value).split(/\s+/).filter(Boolean);
        let count = 0;
        rows.forEach(row => {
            const text = normalize(row.dataset.search);
            const match = (filter.value === 'all' || row.dataset.status === filter.value) && terms.every(term => text.includes(term));
            row.hidden = !match || ++count > limit;
            if (row.hidden) row.querySelectorAll('details').forEach(details => { details.open = false; });
        });
        empty.hidden = count > 0;
        empty.textContent = rows.length ? 'لا يوجد عملاء مطابقون للبحث أو الحالة.' : 'لا يوجد عملاء لعرضهم.';
        footer.hidden = count === 0;
        more.hidden = count <= limit;
        progress.textContent = `عرض ${Math.min(limit, count)} من ${count} عميل`;
    };
    search.addEventListener('input', () => { limit = 20; render(); });
    filter.addEventListener('change', () => { limit = 20; render(); });
    more.addEventListener('click', () => { limit += 20; render(); });
    render();
})();
