(() => {
    'use strict';
    const root = document.querySelector('[data-executor-directory]');
    if (!root) return;
    const search = root.querySelector('[data-executor-search]');
    const status = root.querySelector('[data-executor-status]');
    const kind = root.querySelector('[data-executor-kind]');
    const normalize = value => value.trim().toLocaleLowerCase('ar');
    const filter = () => {
        const term = normalize(search.value);
        root.querySelectorAll('[role="tabpanel"]').forEach(pane => {
            let count = 0;
            pane.querySelectorAll('[data-executor-card]').forEach(card => {
                const matches = normalize(card.dataset.search).includes(term)
                    && (kind.value === 'all' || card.dataset.kind === kind.value)
                    && (status.value === 'all' || (status.value === 'active' ? card.dataset.status === 'active' : card.dataset.status !== 'active'));
                card.hidden = !matches;
                if (matches) count++;
            });
            pane.querySelector('[data-executor-empty]').hidden = count > 0;
            if (pane.classList.contains('active')) root.querySelector('[data-executor-result]').textContent = `${count} حساب مطابق`;
        });
    };
    search.addEventListener('input', filter);
    status.addEventListener('change', filter);
    kind.addEventListener('change', filter);
    root.addEventListener('shown.bs.tab', filter);
    filter();
})();
