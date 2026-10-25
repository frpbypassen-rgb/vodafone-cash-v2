(() => {
    'use strict';
    if (document.documentElement.dataset.portal !== 'company') return;
    import('./portal-workspace/header.js').catch((error) => console.error('[Company header]', error));
})();
