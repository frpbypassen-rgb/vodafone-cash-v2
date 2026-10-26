(() => {
    'use strict';
    const root = document.querySelector('.agent-balances');
    if (!root) return;
    const search = root.querySelector('[data-balance-search]');
    const filter = root.querySelector('[data-balance-filter]');
    const sort = root.querySelector('[data-balance-sort]');
    const list = root.querySelector('[data-balance-list]');
    const rows = Array.from(root.querySelectorAll('[data-balance-row]'));
    const empty = root.querySelector('[data-balance-empty]');
    const footer = root.querySelector('[data-balance-footer]');
    const more = root.querySelector('[data-balance-more]');
    const progress = root.querySelector('[data-balance-progress]');
    const normalize = text => String(text).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).toLocaleLowerCase('ar').trim();
    let limit = 20;
    const render = () => {
        const terms = normalize(search.value).split(/\s+/).filter(Boolean);
        const ordered = rows.slice().sort((a, b) => {
            const difference = Number(b.dataset.balance) - Number(a.dataset.balance);
            if (sort.value === 'balance' && difference) return difference;
            if (sort.value === 'debt' && difference) return -difference;
            return a.dataset.name.localeCompare(b.dataset.name, 'ar');
        });
        let count = 0;
        ordered.forEach(row => {
            const balance = Number(row.dataset.balance);
            const matchesFilter = filter.value === 'all' || (filter.value === 'positive' && balance > 0) || (filter.value === 'debt' && balance < 0) || (filter.value === 'zero' && balance === 0);
            const text = normalize(row.dataset.search);
            const matches = matchesFilter && terms.every(term => text.includes(term));
            row.hidden = !matches || ++count > limit;
            list.append(row);
        });
        empty.hidden = count > 0;
        empty.textContent = rows.length ? 'لا يوجد عملاء مطابقون للبحث أو الفلتر.' : 'لا يوجد عملاء لعرضهم.';
        footer.hidden = count === 0;
        progress.textContent = `عرض ${Math.min(limit, count)} من ${count} عميل`;
        more.hidden = count <= limit;
    };
    search.addEventListener('input', () => { limit = 20; render(); });
    [filter, sort].forEach(control => control.addEventListener('change', () => { limit = 20; render(); }));
    more.addEventListener('click', () => { limit += 20; render(); });
    render();
})();
