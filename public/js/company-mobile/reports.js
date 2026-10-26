(() => {
    'use strict';
    const root = document.querySelector('.agent-reports');
    if (!root) return;
    const search = root.querySelector('[data-report-search]');
    const rows = Array.from(root.querySelectorAll('[data-report-row]'));
    const empty = root.querySelector('[data-report-empty]');
    const footer = root.querySelector('[data-report-footer]');
    const more = root.querySelector('[data-report-more]');
    const progress = root.querySelector('[data-report-progress]');
    const normalize = value => String(value).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).toLocaleLowerCase('ar').trim();
    let limit = 20;
    const render = () => {
        const terms = normalize(search.value).split(/\s+/).filter(Boolean);
        let count = 0;
        rows.forEach(row => {
            const text = normalize(row.dataset.search);
            row.hidden = !terms.every(term => text.includes(term)) || ++count > limit;
            if (row.hidden) row.open = false;
        });
        empty.hidden = count > 0;
        empty.textContent = rows.length ? 'لا توجد نتائج مطابقة للبحث.' : 'لا توجد نتائج لهذه الفترة.';
        footer.hidden = count === 0;
        more.hidden = count <= limit;
        progress.textContent = `عرض ${Math.min(limit,count)} من ${count} نتيجة`;
    };
    search.addEventListener('input', () => { limit = 20; render(); });
    more.addEventListener('click', () => { limit += 20; render(); });
    root.querySelector('[data-report-print]')?.addEventListener('click', () => { window.print(); });
    let printState;
    window.addEventListener('beforeprint', () => {
        printState = rows.map(row => ({row, hidden:row.hidden, open:row.open}));
        rows.forEach(row => { row.hidden = false; row.open = true; });
    });
    window.addEventListener('afterprint', () => {
        printState?.forEach(({row,hidden,open}) => { row.hidden = hidden; row.open = open; });
        printState = undefined;
    });
    render();
})();
