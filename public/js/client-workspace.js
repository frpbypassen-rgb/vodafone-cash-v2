(() => {
    'use strict';
    if (document.documentElement.dataset.portal === 'agent') return;
    import('./portal-workspace/main.js').then(() => { document.body.dataset.workspaceReady = 'true'; })
        .catch(error => { console.error('[Client workspace] initialization failed:', error); });
})();
