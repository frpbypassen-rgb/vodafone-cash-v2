'use strict';

const eventBus = require('./eventBus');
const ClientCompany = require('../models/ClientCompany');
const { createClientNotifications } = require('./clientNotificationService');

eventBus.on('transfer:completed', async ({ tx }) => {
    try {
        if (!tx?.companyId) return;
        const company = await ClientCompany.findById(tx.companyId).select('_id name balance creditLimit').lean();
        if (!company) return;
        await createClientNotifications({
            accountModel: 'ClientCompany',
            account: company,
            title: 'تم إتمام التحويل',
            message: `اكتملت العملية ${tx.customId || ''} بنجاح.`,
            type: 'transfer_complete',
            txId: tx.customId,
            metadata: { href: '/client/transactions' }
        });
    } catch (_error) { /* delivery is best-effort */ }
});

module.exports = {};
