const {
    redirectWithMessage,
    customerOwnerFilter,
    requireCustomerManager,
    cleanText,
    runDbTransaction,
    nextSettlementId,
} = require('./common');
('use strict');
const businessPortalService = require('../../services/businessPortalService');
const SubAccount = require('../../models/SubAccount');
const { logAction } = require('../../services/auditService');
const {
    normalizeCreditLimit,
    assertCreditLimitCanCoverBalance,
} = require('../../services/agencyCreditLimitService');
const Transaction = require('../../models/Transaction');
const { updateBalanceWithLedger } = require('../../services/walletService');
const { notifyBalanceAdjustment } = require('../../services/clientNotificationService');
const { createDepositReceiptProof } = require('../../services/depositReceiptService');
const { recordCustomerSettlement } = require('../../services/agencyJournalService');
const AgencyJournal = require('../../models/AgencyJournal');

exports.postUpdateCustomerCreditLimit = async (req, res) => {
    let returnPath = '/client/customers';
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        if (!workspace.isAgent) throw new Error('FORBIDDEN');

        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, returnPath, 'customerError', 'notfound');

        returnPath =
            req.body.returnTo === 'customers' ? '/client/customers' : `/client/customers/${customer._id}`;

        const creditLimit = normalizeCreditLimit(req.body.creditLimit, { required: true });
        assertCreditLimitCanCoverBalance({ balance: customer.balance, creditLimit });

        const oldCreditLimit = Number(customer.creditLimit || 0);
        if (oldCreditLimit === creditLimit) {
            return redirectWithMessage(res, returnPath, 'customerSuccess', 'credit_limit');
        }

        customer.creditLimit = creditLimit;
        customer.creditLimitUpdatedAt = new Date();
        customer.creditLimitUpdatedBy = workspace.actor.name;
        customer.creditLimitUpdatedByModel = workspace.actorModel;
        customer.creditLimitUpdatedById = workspace.actor._id;
        await customer.save();

        await logAction({
            action: 'SUB_ACCOUNT_CREDIT_LIMIT_UPDATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            oldData: { creditLimit: oldCreditLimit },
            newData: { creditLimit, minimumBalance: -creditLimit },
            result: 'SUCCESS',
            metadata: {
                portal: workspace.type,
                customerBalance: Number(customer.balance || 0),
            },
        });

        const io = req.app?.get('io');
        if (io) io.emit('update_data');
        return redirectWithMessage(res, returnPath, 'customerSuccess', 'credit_limit');
    } catch (error) {
        const code =
            error.code === 'INVALID_CREDIT_LIMIT'
                ? 'credit_limit'
                : error.code === 'CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT'
                  ? 'limit_below_debt'
                  : error.message === 'FORBIDDEN'
                    ? 'forbidden'
                    : 'server';
        console.error('[Business Portal] customer credit limit update failed:', error.message);
        return redirectWithMessage(res, returnPath, 'customerError', code);
    }
};

exports.postAdjustCustomerBalance = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, '/client/customers', 'customerError', 'notfound');

        const amount = Number(req.body.amount);
        const aliases = { deposit: 'customer_payment', withdraw: 'customer_payout' };
        const requestedCategory =
            aliases[req.body.operation] || String(req.body.operation || 'customer_payment');
        const allowedCategories = new Set([
            'customer_payment',
            'customer_payout',
            'debt_payment',
            'balance_credit',
            'balance_debit',
        ]);
        const category = allowedCategories.has(requestedCategory) ? requestedCategory : 'customer_payment';
        const creditCategories = new Set(['customer_payment', 'debt_payment', 'balance_credit']);
        const isCredit = creditCategories.has(category);
        const operation = isCredit ? 'deposit' : 'withdraw';
        const note = cleanText(req.body.note, 240);
        const paymentMethod = ['cash', 'bank', 'wallet', 'other'].includes(req.body.paymentMethod)
            ? req.body.paymentMethod
            : 'cash';
        const externalReference = cleanText(req.body.externalReference, 100);
        if (!Number.isFinite(amount) || amount <= 0) {
            return redirectWithMessage(res, '/client/customers', 'customerError', 'amount');
        }
        const delta = operation === 'deposit' ? amount : -amount;
        const adjustment = await runDbTransaction(async (session) => {
            const transactionId = await nextSettlementId(session);
            let balanceApplied = false;
            try {
                const balanceResult = await updateBalanceWithLedger(
                    'SubAccount',
                    customer._id,
                    delta,
                    operation === 'deposit' ? 'DEPOSIT' : 'DEDUCTION',
                    transactionId,
                    note ||
                        (operation === 'deposit'
                            ? `تمويل العميل ${customer.name}`
                            : `سحب من رصيد العميل ${customer.name}`),
                    { minBalance: 0, allowNegative: true, ...(session ? { session } : {}) }
                );
                balanceApplied = true;

                const [transaction] = await Transaction.create(
                    [
                        {
                            customId: transactionId,
                            userId: workspace.isAgent
                                ? workspace.entity.phone || workspace.entity.webUsername
                                : null,
                            companyId: workspace.isCompany ? workspace.entity._id : null,
                            companyName: workspace.entity.name,
                            employeeName: workspace.actor.name,
                            subAccountId: customer._id,
                            subAccountName: customer.name,
                            isSubAccountTx: true,
                            vodafoneNumber: customer.accountCode || customer.phone,
                            amount,
                            costLYD: 0,
                            status: operation === 'deposit' ? 'deposit' : 'deduction',
                            notes: note,
                            customerNotes: note,
                            adminNotes: operation === 'deposit' ? 'تمويل عميل تابع' : 'سحب من عميل تابع',
                            balanceAdjustment: {
                                entityModel: 'SubAccount',
                                entityId: customer._id,
                                delta,
                                reversible: true,
                            },
                            settlementDetails: {
                                category,
                                paymentMethod,
                                externalReference,
                                statement: note,
                                settledBy: workspace.actor.name,
                            },
                        },
                    ],
                    session ? { session } : {}
                );

                const proofId = createDepositReceiptProof({
                    customId: transactionId,
                    accountName: customer.name,
                    accountCode: customer.accountCode || customer.webUsername || customer.phone || '',
                    amount,
                    balanceAfter: balanceResult.balanceAfter,
                    notes: note,
                    createdAt: transaction.createdAt,
                    type: operation === 'deposit' ? 'deposit' : 'deduction',
                });
                transaction.proofImage = proofId;
                transaction.proofImages = [proofId];
                await transaction.save(session ? { session } : {});

                await recordCustomerSettlement(
                    {
                        transactionId,
                        subAccount: customer,
                        category,
                        amount,
                        delta,
                        actor: {
                            _id: workspace.actor._id,
                            model: workspace.actorModel,
                            name: workspace.actor.name,
                        },
                        metadata: { paymentMethod, externalReference, note },
                    },
                    session
                );

                return { transaction, transactionId, balanceAfter: balanceResult.balanceAfter };
            } catch (error) {
                if (!session) {
                    await AgencyJournal.deleteMany({ transactionId }).catch(() => {});
                    await Transaction.deleteOne({ customId: transactionId }).catch(() => {});
                    await require('../../models/Ledger')
                        .deleteMany({ transactionId })
                        .catch(() => {});
                    if (balanceApplied) {
                        await SubAccount.updateOne(
                            { _id: customer._id },
                            { $inc: { balance: -delta } }
                        ).catch(() => {});
                    }
                }
                throw error;
            }
        });

        await notifyBalanceAdjustment({
            accountModel: 'SubAccount',
            account: customer,
            amount: delta,
            balanceAfter: adjustment.balanceAfter,
            customId: adjustment.transactionId,
            notes: note,
        }).catch(() => {});
        const io = req.app?.get('io');
        if (io) io.emit('update_data');

        await logAction({
            action: operation === 'deposit' ? 'BALANCE_ADDED' : 'BALANCE_DEDUCTED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            result: 'ناجح',
            metadata: {
                amount,
                transactionId: adjustment.transactionId,
                portal: workspace.type,
                category,
                paymentMethod,
                externalReference,
            },
        });

        const returnPath =
            req.body.returnTo === 'profile' ? `/client/customers/${customer._id}` : '/client/customers';
        return redirectWithMessage(res, returnPath, 'customerSuccess', category);
    } catch (error) {
        console.error('[Business Portal] customer balance failed:', error.message);
        const code =
            error.message === 'FORBIDDEN'
                ? 'forbidden'
                : error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE'
                  ? 'temporarily-unavailable'
                  : error.message === 'INSUFFICIENT_BALANCE'
                    ? 'funds'
                    : error.message === 'ACCOUNT_NOT_FOUND'
                      ? 'notfound'
                      : 'server';
        return redirectWithMessage(res, '/client/customers', 'customerError', code);
    }
};
