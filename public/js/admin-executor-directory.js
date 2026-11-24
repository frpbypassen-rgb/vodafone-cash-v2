(() => {
    'use strict';
    const root = document.querySelector('[data-executor-directory]');
    if (!root) return;
    const search = root.querySelector('[data-executor-search]');
    const status = root.querySelector('[data-executor-status]');
    const kind = root.querySelector('[data-executor-kind]');
    const reset = root.querySelector('[data-executor-reset]');
    const normalize = value => String(value || '').trim().toLocaleLowerCase('ar');
    const filter = () => {
        const term = normalize(search.value);
        const archiveSelected = root.querySelector('#archived-executors-pane')?.classList.contains('active');
        status.disabled = archiveSelected;
        reset.hidden = !term && status.value === 'all' && kind.value === 'all';
        root.querySelectorAll('[role="tabpanel"]').forEach(pane => {
            let count = 0;
            const archived = pane.id === 'archived-executors-pane';
            pane.querySelectorAll('[data-executor-card]').forEach(card => {
                const matches = normalize(card.dataset.search).includes(term)
                    && (kind.value === 'all' || card.dataset.kind === kind.value)
                    && (archived || status.value === 'all' || (status.value === 'active' ? card.dataset.status === 'active' : card.dataset.status !== 'active'));
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
    reset.addEventListener('click', () => {
        search.value = '';
        status.value = 'all';
        kind.value = 'all';
        filter();
        search.focus();
    });
    root.addEventListener('shown.bs.tab', filter);
    filter();
})();
