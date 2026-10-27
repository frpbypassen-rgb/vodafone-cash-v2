(() => {
    'use strict';
    const root = document.querySelector('[data-executor-detail]');
    if (!root) return;
    root.querySelector('[data-executor-detail-tab]')?.addEventListener('change', event => window.location.assign(event.target.value));
    const openAnchor = () => {
        const hash = location.hash;
        const tab = hash === '#settlementForm' ? 'ledger' : hash === '#executor-status' ? 'settings' : null;
        if (!tab) return;
        if (root.dataset.tab !== tab) {
            const url = new URL(location.href);
            url.search = new URLSearchParams({tab}).toString();
            window.location.replace(url.href);
            return;
        }
        const panel = root.querySelector('[data-settlement-panel]');
        if (tab === 'ledger' && panel) panel.open = true;
        document.querySelector(hash)?.scrollIntoView({block:'center'});
    };
    window.addEventListener('hashchange', openAnchor);
    openAnchor();
})();
