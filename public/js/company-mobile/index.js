import { config } from '../portal-workspace/core.js';
import '../portal-workspace/shell.js';
import '../portal-workspace/company-notices.js';

(async () => {
    if (document.documentElement.dataset.portal === 'company' && config.workspaceType === 'company') {
        const modules = [import('../portal-workspace/header.js?v=20261027-performance')];
        const page = config.page;
        if (document.getElementById('businessTransferForm')) {
            modules.push(import('../portal-workspace/transfers.js'), import('../portal-workspace/tools.js'));
        }
        if (page === 'smart_transfer') modules.push(import('../portal-workspace/smart-transfer.js'));
        if (page === 'internal_transfer') modules.push(import('../portal-workspace/balance-transfer.js'));
        if (page === 'support') modules.push(import('../portal-workspace/support.js'));
        if (['overview', 'transactions', 'reports', 'service_workbench'].includes(page))
            modules.push(import('../portal-workspace/receipts.js'));
        if (['overview', 'reports', 'transactions'].includes(page))
            modules.push(import('../portal-workspace/reports.js'));
        if (
            [
                'overview',
                'reports',
                'service_workbench',
                'smart_transfer',
                'settings',
                'security',
                'deposits',
            ].includes(page)
        )
            modules.push(import('../portal-workspace/presentation.js'));
        if (document.getElementById('businessAssistantOpen'))
            modules.push(import('../portal-workspace/assistant.js'));
        try {
            await Promise.all(modules);
            document.body.dataset.workspaceReady = 'true';
        } catch (error) {
            console.error('[Company portal] initialization failed:', error);
        }
    }
})();
