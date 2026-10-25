(() => {
    'use strict';
    if (document.documentElement.dataset.portal !== 'agent' || window.agentPortal?.workspaceType !== 'agent')
        return;
    import('../portal-workspace/main.js')
        .then(() =>
            Promise.all([
                import('../portal-workspace/header.js'),
                import('../portal-workspace/presentation.js'),
            ])
        )
        .then(() => {
            document.body.dataset.workspaceReady = 'true';
        })
        .catch((error) => {
            console.error('[Agent portal] initialization failed:', error);
        });
})();
