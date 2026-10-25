(() => {
    'use strict';
    if (document.documentElement.dataset.portal !== 'company') return;
    import('./portal-workspace/presentation.js').catch((error) =>
        console.error('[Company presentation]', error)
    );
})();
