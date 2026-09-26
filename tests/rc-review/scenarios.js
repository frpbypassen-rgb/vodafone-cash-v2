'use strict';

const request = require('supertest');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const adminSession = (ids) => ({
    isLoggedIn: true,
    adminId: String(ids.admin),
    adminName: 'RC Review Admin',
    adminRole: 'master',
    csrfToken: 'csrf-review-token',
    destroy(callback) { if (callback) callback(); }
});

const clientSession = (clientId, accountType) => ({
    isClientLoggedIn: true,
    clientId: String(clientId),
    accountType,
    clientSessionVersion: 0,
    clientName: 'مراجعة',
    destroy(callback) { if (callback) callback(); }
});

const executorSession = (ids) => ({
    isExecutorLoggedIn: true,
    executorId: String(ids.humanEmployee),
    destroy(callback) { if (callback) callback(); }
});

const expectOk = (res, label) => {
    if (res.status >= 400 || (res.body && res.body.success === false)) {
        throw new Error(`${label} failed status=${res.status} body=${JSON.stringify(res.body)}`);
    }
    return res.body || {};
};

const createPortalTransfer = async (ctx, { clientId, accountType, amount, phone }) => {
    ctx.holder.session = clientSession(clientId, accountType);
    const res = await request(ctx.app)
        .post('/client/transfer')
        .set('Accept', 'application/json')
        .send({ amount, type: 'كاش', phone, name: 'مستلم مراجعة' });
    const body = expectOk(res, `portal transfer ${phone}`);
    if (!body.customId) throw new Error(`portal transfer missing customId ${JSON.stringify(body)}`);
    return body;
};

const assignHuman = async (ctx, customId) => {
    const tx = await ctx.models.Transaction.findOne({ customId });
    if (!tx) throw new Error(`missing transaction ${customId}`);
    ctx.holder.session = adminSession(ctx.ids);
    const res = await request(ctx.app)
        .post(`/transaction/${tx._id}/assign-executor`)
        .set('Accept', 'application/json')
        .send({ executorGroupId: String(ctx.ids.humanGroup) });
    expectOk(res, `assign ${customId}`);
    return tx._id;
};

const acceptAndComplete = async (ctx, txId, senderEntries, executionNumber) => {
    ctx.holder.session = executorSession(ctx.ids);
    const accepted = await request(ctx.app)
        .post(`/executor-portal/api/accept-task/${txId}`)
        .set('Accept', 'application/json')
        .send({});
    expectOk(accepted, `accept ${txId}`);
    const completed = await request(ctx.app)
        .post(`/executor-portal/api/complete-task/${txId}`)
        .set('Accept', 'application/json')
        .send({
            executionNumber,
            senderEntries
        });
    expectOk(completed, `complete ${txId}`);
};

const humanFlow = async (ctx, spec) => {
    const created = await createPortalTransfer(ctx, spec);
    const txId = await assignHuman(ctx, created.customId);
    await acceptAndComplete(
        ctx,
        txId,
        spec.senderEntries || [{ phone: spec.executionNumber, amount: spec.amount }],
        spec.executionNumber
    );
    await sleep(350);
    return { customId: created.customId, newBalance: created.newBalance };
};

const runScenarios = async (ctx) => {
    const results = {};
    const steps = [
        ['1_client_user', () => humanFlow(ctx, {
            clientId: ctx.ids.client,
            accountType: 'client',
            amount: 200,
            phone: '01055550101',
            executionNumber: '01055550901'
        })],
        ['1_company', () => humanFlow(ctx, {
            clientId: ctx.ids.companyEmployee,
            accountType: 'company',
            amount: 300,
            phone: '01055550102',
            executionNumber: '01055550902'
        })],
        ['1_agent_staff', () => humanFlow(ctx, {
            clientId: ctx.ids.agentEmployee,
            accountType: 'agent_staff',
            amount: 400,
            phone: '01055550103',
            executionNumber: '01055550903'
        })],
        ['1_sub_account_commission', () => humanFlow(ctx, {
            clientId: ctx.ids.sub,
            accountType: 'sub_client',
            amount: 250,
            phone: '01055550104',
            executionNumber: '01055550904'
        })],
        ['2_split_2500', () => humanFlow(ctx, {
            clientId: ctx.ids.client,
            accountType: 'client',
            amount: 2500,
            phone: '01055550105',
            executionNumber: '01108172258',
            senderEntries: [
                { phone: '01108172258', amount: 1000 },
                { phone: '01000926306', amount: 1500 }
            ]
        })],
        ['3_merchant_company', async () => {
            ctx.holder.session = {};
            const res = await request(ctx.app)
                .post('/api/v1/merchant/transfer')
                .set('Accept', 'application/json')
                .set('x-api-key', 'company-token-rc-review')
                .send({ target_number: '01055550106', amount: 800, transfer_type: 'vodafone' });
            const body = expectOk(res, 'merchant company');
            if (body.status !== 'success') throw new Error(JSON.stringify(body));
            return body.data;
        }],
        ['3_merchant_agent', async () => {
            const res = await request(ctx.app)
                .post('/api/v1/merchant/transfer')
                .set('Accept', 'application/json')
                .set('x-api-key', 'agent-token-rc-review')
                .send({ target_number: '01055550107', amount: 640, transfer_type: 'vodafone' });
            const body = expectOk(res, 'merchant agent');
            if (body.status !== 'success') throw new Error(JSON.stringify(body));
            return body.data;
        }],
        ['4_auto_route_immediate', async () => {
            await ctx.models.Settings.updateOne({}, {
                $set: {
                    autoRouteEnabled: true,
                    autoRouteStrategy: 'fixed',
                    autoRouteRules: [{ serviceKey: 'vodafone', executorGroupId: ctx.ids.apiGroup }]
                }
            });
            const bull = ctx.load('services/bullQueueService');
            if (typeof bull.initBullMQ === 'function') bull.initBullMQ();
            const created = await createPortalTransfer(ctx, {
                clientId: ctx.ids.client,
                accountType: 'client',
                amount: 160,
                phone: '01055550108'
            });
            let tx = null;
            for (let attempt = 0; attempt < 40; attempt += 1) {
                tx = await ctx.models.Transaction.findOne({ customId: created.customId }).lean();
                if (tx && tx.status === 'completed') break;
                await sleep(250);
            }
            await ctx.models.Settings.updateOne({}, { $set: { autoRouteEnabled: false, autoRouteRules: [] } });
            if (!tx || tx.status !== 'completed') {
                throw new Error(`auto-route did not complete immediately status=${tx && tx.status} notes=${tx && tx.adminNotes}`);
            }
            return { customId: created.customId, status: tx.status, completionMode: tx.apiResultData && tx.apiResultData.completionMode };
        }],
        ['5_provider_paid_scheduler', async () => {
            await ctx.models.Settings.updateOne({}, { $set: { autoRouteEnabled: false, autoRouteRules: [] } });
            const created = await createPortalTransfer(ctx, {
                clientId: ctx.ids.client,
                accountType: 'client',
                amount: 180,
                phone: '01055550109'
            });
            const tx = await ctx.models.Transaction.findOne({ customId: created.customId });
            const group = await ctx.models.ExecutorGroup.findById(ctx.ids.apiGroup);
            const lifecycle = ctx.load('services/apiExecutionLifecycleService');
            const prepared = lifecycle.prepareApiTransactionForDelayedCompletion({
                tx,
                executorGroup: group,
                apiResult: {
                    success: true,
                    reference_number: 'LOCAL-DELAY-REF',
                    external_transaction_id: 'LOCAL-DELAY-PROV',
                    sender_number: 'LOCAL-DELAY-REF'
                },
                receiptProof: null,
                detailedLog: 'rc-review delayed fixture'
            });
            if (!prepared) throw new Error('prepareApiTransactionForDelayedCompletion returned null');
            tx.apiResultData.autoCompleteAt = new Date(Date.now() - 1000);
            await tx.save();
            const paymentsBefore = ctx.http.snapshotCounters().providerPayment;
            await lifecycle.completeDueApiTransactions();
            await sleep(350);
            const after = await ctx.models.Transaction.findOne({ customId: created.customId }).lean();
            return {
                customId: created.customId,
                status: after && after.status,
                waiting: after && after.apiResultData && after.apiResultData.waitingApiAutoCompletion,
                providerPaymentsDuringScheduler: ctx.http.snapshotCounters().providerPayment - paymentsBefore
            };
        }],
        ['6_executor_cancel', async () => {
            const created = await createPortalTransfer(ctx, {
                clientId: ctx.ids.client,
                accountType: 'client',
                amount: 220,
                phone: '01055550110'
            });
            const txId = await assignHuman(ctx, created.customId);
            ctx.holder.session = executorSession(ctx.ids);
            const accepted = await request(ctx.app)
                .post(`/executor-portal/api/accept-task/${txId}`)
                .set('Accept', 'application/json')
                .send({});
            expectOk(accepted, 'accept before cancel');
            const cancelled = await request(ctx.app)
                .post(`/executor-portal/api/cancel-task/${txId}`)
                .set('Accept', 'application/json')
                .send({ reason: 'رفض مراجعة' });
            expectOk(cancelled, 'executor cancel');
            const after = await ctx.models.Transaction.findOne({ customId: created.customId }).lean();
            return { customId: created.customId, status: after && after.status };
        }],
        ['6_admin_reversal', async () => {
            const created = await createPortalTransfer(ctx, {
                clientId: ctx.ids.companyEmployee,
                accountType: 'company',
                amount: 260,
                phone: '01055550111'
            });
            const tx = await ctx.models.Transaction.findOne({ customId: created.customId });
            ctx.holder.session = adminSession(ctx.ids);
            const res = await request(ctx.app)
                .post(`/transaction/${tx._id}/global-cancel`)
                .set('Accept', 'application/json')
                .send({ reason: 'إلغاء إداري للمراجعة' });
            expectOk(res, 'admin reversal');
            const after = await ctx.models.Transaction.findOne({ customId: created.customId }).lean();
            return { customId: created.customId, status: after && after.status };
        }],
        ['7_admin_deposit_debit_treasury_transfer', async () => {
            ctx.holder.session = adminSession(ctx.ids);
            const deposit = await request(ctx.app)
                .post(`/user/${ctx.ids.client}/add-balance`)
                .set('Accept', 'application/json')
                .send({ amount: 400, notes: 'إيداع مراجعة' });
            if (deposit.status >= 400) throw new Error(`deposit failed ${deposit.status} ${deposit.text}`);

            const debit = await request(ctx.app)
                .post(`/company/${ctx.ids.company}/add-balance`)
                .set('Accept', 'application/json')
                .send({ amount: -80, notes: 'خصم مراجعة' });
            if (debit.status >= 400) throw new Error(`debit failed ${debit.status} ${debit.text}`);

            const treasury = await request(ctx.app)
                .post(`/executor/${ctx.ids.humanGroup}/settle`)
                .set('Accept', 'application/json')
                .set('x-csrf-token', 'csrf-review-token')
                .send({ amount: -200, notes: 'حركة خزينة مراجعة', _csrf: 'csrf-review-token' });
            if (treasury.status >= 400) throw new Error(`treasury failed ${treasury.status} ${treasury.text}`);

            ctx.holder.session = clientSession(ctx.ids.companyEmployee, 'company');
            const moved = await request(ctx.app)
                .post('/client/balance-transfer')
                .set('Accept', 'application/json')
                .send({ targetAccountCode: '3001', amount: 50, notes: 'تحويل شركة إلى وكيل' });
            if (moved.status >= 400) {
                return {
                    identicalExistingFailure: true,
                    status: moved.status,
                    error: moved.body && moved.body.error
                };
            }
            return { transferId: moved.body && moved.body.transferId };
        }],
        ['8_insufficient_balance', async () => {
            ctx.holder.session = clientSession(ctx.ids.poor, 'client');
            const poorBefore = await ctx.models.User.findById(ctx.ids.poor).select('balance').lean();
            const clientRes = await request(ctx.app)
                .post('/client/transfer')
                .set('Accept', 'application/json')
                .send({ amount: 200, type: 'كاش', phone: '01055550112', name: 'مستلم' });
            const poorAfter = await ctx.models.User.findById(ctx.ids.poor).select('balance').lean();

            const agentBefore = await ctx.models.User.findById(ctx.ids.agent).select('balance').lean();
            const merchantRes = await request(ctx.app)
                .post('/api/v1/merchant/transfer')
                .set('Accept', 'application/json')
                .set('x-api-key', 'agent-token-rc-review')
                .send({ target_number: '01055550113', amount: 50000, transfer_type: 'vodafone' });
            const agentAfter = await ctx.models.User.findById(ctx.ids.agent).select('balance').lean();

            ctx.holder.session = clientSession(ctx.ids.poor, 'client');
            const moveRes = await request(ctx.app)
                .post('/client/balance-transfer')
                .set('Accept', 'application/json')
                .send({ targetAccountCode: '3001', amount: 10 });
            return {
                clientStatus: clientRes.status,
                clientError: clientRes.body && (clientRes.body.error || clientRes.body.message),
                poorBefore: poorBefore.balance,
                poorAfter: poorAfter.balance,
                merchantStatus: merchantRes.status,
                merchantBody: merchantRes.body && (merchantRes.body.message || merchantRes.body.status),
                agentBefore: agentBefore.balance,
                agentAfter: agentAfter.balance,
                moveStatus: moveRes.status,
                moveError: moveRes.body && (moveRes.body.error || moveRes.body.message)
            };
        }]
    ];

    for (const [name, fn] of steps) {
        const httpBefore = ctx.http.snapshotCounters();
        try {
            const detail = await fn();
            results[name] = { ok: true, detail };
        } catch (error) {
            results[name] = { ok: false, error: error.stack || error.message };
        }
        await sleep(200);
        results[name].snapshot = await ctx.snapshot();
        const httpAfter = ctx.http.snapshotCounters();
        results[name].providerPayments = httpAfter.providerPayment - httpBefore.providerPayment;
        results[name].messageSends = (httpAfter.messageSends + httpAfter.webhookPosts + httpAfter.smtpSends)
            - (httpBefore.messageSends + httpBefore.webhookPosts + httpBefore.smtpSends);
    }
    return results;
};

module.exports = { runScenarios };
