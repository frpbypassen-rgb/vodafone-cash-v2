(() => {
    'use strict';
    const root = document.querySelector('.agent-staff');
    if (!root) return;
    const search = root.querySelector('[data-staff-search]');
    const status = root.querySelector('[data-staff-status]');
    const role = root.querySelector('[data-staff-role]');
    const rows = Array.from(root.querySelectorAll('[data-staff-row]'));
    const empty = root.querySelector('[data-staff-empty]');
    const footer = root.querySelector('[data-staff-footer]');
    const more = root.querySelector('[data-staff-more]');
    const progress = root.querySelector('[data-staff-progress]');
    const normalize = value => String(value).normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).toLocaleLowerCase('ar').trim();
    let limit = 20;
    const render = () => {
        const terms = normalize(search.value).split(/\s+/).filter(Boolean);
        let count = 0;
        rows.forEach(row => {
            const text = normalize(row.dataset.search);
            const match = (!status.value || row.dataset.status === status.value) && (!role.value || row.dataset.role === role.value) && terms.every(term => text.includes(term));
            row.hidden = !match || ++count > limit;
            if (row.hidden) row.open = false;
        });
        empty.hidden = count > 0;
        empty.textContent = rows.length ? 'لا يوجد موظفون مطابقون للبحث أو الفلاتر.' : 'لا توجد حسابات موظفين.';
        footer.hidden = count === 0;
        more.hidden = count <= limit;
        progress.textContent = `عرض ${Math.min(limit, count)} من ${count} موظف`;
    };
    search.addEventListener('input', () => { limit = 20; render(); });
    [status, role].forEach(control => control.addEventListener('change', () => { limit = 20; render(); }));
    more.addEventListener('click', () => { limit += 20; render(); });
    render();
})();
