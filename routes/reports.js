const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const { requireAuth } = require('../middlewares/auth');

// Helpers for start/end dates
function getDateRange(dateStr, monthStr) {
    if (dateStr) {
        // Specific day
        const start = new Date(dateStr);
        start.setHours(0, 0, 0, 0);
        const end = new Date(dateStr);
        end.setHours(23, 59, 59, 999);
        return { start, end };
    } else if (monthStr) {
        // Specific month e.g. "2026-06"
        const [year, month] = monthStr.split('-');
        const start = new Date(year, parseInt(month) - 1, 1);
        const end = new Date(year, parseInt(month), 0, 23, 59, 59, 999);
        return { start, end };
    }
    // Default to today
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

router.get('/reports', requireAuth, async (req, res) => {
    try {
        // 1. Direct Clients (Users that are NOT agents, meaning no subAccounts)
        // For simplicity, we just fetch all users. We can filter agents out in frontend if needed.
        const allUsers = await User.find({ role: 'user' }).select('_id name phone').lean();
        
        // 2. Companies
        const companies = await ClientCompany.find().select('_id name').lean();
        // Get distinct employees for each company
        for (let c of companies) {
            c.employees = await Transaction.distinct('employeeName', { companyId: c._id });
        }

        // 3. Agents
        const distinctMasterIds = await SubAccount.distinct('masterId');
        // Fetch masters from User and ClientCompany
        const agentUsers = await User.find({ _id: { $in: distinctMasterIds } }).select('_id name phone').lean();
        const agentCompanies = await ClientCompany.find({ _id: { $in: distinctMasterIds } }).select('_id name').lean();
        const agents = [...agentUsers.map(a => ({...a, type: 'user'})), ...agentCompanies.map(a => ({...a, type: 'company'}))];
        
        // Populate their subaccounts
        for (let a of agents) {
            a.subAccounts = await SubAccount.find({ masterId: a._id }).select('_id name phone').lean();
        }

        // 4. Executors
        const executors = await ExecutorGroup.find({ isApiGroup: false }).select('_id name').lean();
        for (let e of executors) {
            e.employees = await Transaction.distinct('executorName', { executorGroupId: e._id });
        }

        // 5. API Executors
        const apiExecutors = await ExecutorGroup.find({ isApiGroup: true }).select('_id name').lean();

        res.render('reports', {
            adminName: req.session.adminName,
            users: allUsers,
            companies,
            agents,
            executors,
            apiExecutors
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('خطأ داخلي في النظام');
    }
});

router.post('/api/reports/filter', requireAuth, async (req, res) => {
    try {
        const { mainCategory, subId, subType, dateType, dateValue } = req.body;
        // dateType: 'day' | 'month', dateValue: string

        const { start, end } = getDateRange(
            dateType === 'day' ? dateValue : null,
            dateType === 'month' ? dateValue : null
        );

        let baseQuery = {};
        let entityInfo = {
            name: '---',
            phone: '---',
            username: '---',
            joinDate: null,
            status: '---'
        };

        if (mainCategory === 'direct_client') {
            const user = await User.findById(subId).lean();
            if (user) {
                entityInfo = {
                    name: user.name || '---',
                    phone: user.phone || '---',
                    username: user.webUsername || '---',
                    joinDate: user.createdAt,
                    status: 'عميل فردي مباشر'
                };
                baseQuery.$or = [
                    { userId: user.phone },
                    { userId: user.webUsername },
                    { employeeName: user.name, companyName: { $regex: /عميل فردي/ } }
                ];
                // Remove undefined values from $or array to prevent Mongo errors
                baseQuery.$or = baseQuery.$or.filter(cond => {
                    const val = Object.values(cond)[0];
                    return val !== undefined && val !== null;
                });
            } else {
                baseQuery.userId = subId;
            }
            baseQuery.companyId = null;
            baseQuery.isSubAccountTx = { $ne: true };
        } 
        else if (mainCategory === 'company') {
            baseQuery.companyId = subId;
            const comp = await ClientCompany.findById(subId).lean();
            if (comp) {
                entityInfo = {
                    name: comp.name || '---',
                    phone: comp.phone || '---',
                    username: comp.webUsername || '---',
                    joinDate: comp.createdAt,
                    status: 'شركة'
                };
            }
            if (subType && subType !== 'all') {
                baseQuery.employeeName = subType; 
                entityInfo.name = subType;
                entityInfo.status = `موظف شركة (${comp ? comp.name : '---'})`;
            }
        }
        else if (mainCategory === 'agent') {
            const master = await User.findById(subId).lean() || await ClientCompany.findById(subId).lean();
            if (subType === 'all') {
                if (master) {
                    entityInfo = {
                        name: master.name || '---',
                        phone: master.phone || '---',
                        username: master.webUsername || '---',
                        joinDate: master.createdAt,
                        status: 'وكالة'
                    };
                }
                const agentSubs = await SubAccount.find({ masterId: subId }).select('_id').lean();
                const subIds = agentSubs.map(s => s._id);
                baseQuery.$or = [
                    { subAccountId: { $in: subIds } },
                    { userId: subId, isSubAccountTx: { $ne: true } },
                    { companyId: subId, isSubAccountTx: { $ne: true } }
                ];
            } else {
                baseQuery.subAccountId = subType;
                const subAcc = await SubAccount.findById(subType).lean();
                if (subAcc) {
                    entityInfo = {
                        name: subAcc.name || '---',
                        phone: subAcc.phone || '---',
                        username: subAcc.webUsername || '---',
                        joinDate: subAcc.createdAt,
                        status: `عميل تابع لوكالة (${master ? master.name : '---'})`
                    };
                }
            }
        }
        else if (mainCategory === 'executor') {
            baseQuery.executorGroupId = subId;
            const manager = await Employee.findOne({ groupId: subId, role: 'manager' }).lean();
            if (manager) {
                entityInfo = {
                    name: manager.name || '---',
                    phone: manager.phone || '---',
                    username: manager.webUsername || '---',
                    joinDate: manager.createdAt,
                    status: 'شركة تنفيذ'
                };
            } else {
                entityInfo.status = 'شركة تنفيذ';
            }
            if (subType && subType !== 'all') {
                baseQuery.executorName = subType;
                entityInfo.name = subType;
                entityInfo.status = 'منفذ مالي';
            }
        }
        else if (mainCategory === 'api_executor') {
            baseQuery.executorGroupId = subId;
            entityInfo.status = 'منفذ API';
        }

        // 1. حساب الرصيد السابق
        const prevTransactions = await Transaction.find({ ...baseQuery, createdAt: { $lt: start } }).select('status amount costLYD').lean();
        let previousBalance = 0;
        
        const isExecutor = mainCategory === 'executor' || mainCategory === 'api_executor';

        prevTransactions.forEach(tx => {
            if (tx.status === 'completed') {
                previousBalance -= isExecutor ? (tx.amount || 0) : (tx.costLYD || 0);
            } else if (tx.status === 'deposit') {
                previousBalance += (tx.amount || 0);
            } else if (tx.status === 'deduction') {
                previousBalance -= (tx.amount || 0);
            }
        });

        // 2. جلب وتصنيف معاملات اليوم/الشهر
        const currentTransactions = await Transaction.find({ ...baseQuery, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean();
        
        let totalLYD = 0; // إجمالي التكلفة
        let totalEGP = 0; // إجمالي المبلغ
        let completedCount = 0;
        let rejectedCount = 0;
        let totalDeposits = 0;

        const operations = [];
        const deposits = [];

        currentTransactions.forEach(tx => {
            if (['deposit', 'deduction', 'deposit_pending'].includes(tx.status)) {
                deposits.push(tx);
                if (tx.status === 'deposit') totalDeposits += (tx.amount || 0);
                else if (tx.status === 'deduction') totalDeposits -= (tx.amount || 0);
            } else {
                operations.push(tx);
                if (tx.status === 'completed') {
                    completedCount++;
                    totalLYD += (tx.costLYD || 0);
                    totalEGP += (tx.amount || 0);
                } else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin') {
                    rejectedCount++;
                }
            }
        });

        const totalOperationsCost = isExecutor ? totalEGP : totalLYD;
        const endingBalance = previousBalance + totalDeposits - totalOperationsCost;

        res.json({
            success: true,
            entityInfo,
            stats: { 
                previousBalance,
                endingBalance,
                totalLYD, 
                totalEGP, 
                totalDeposits,
                completedCount, 
                rejectedCount, 
                totalCount: operations.length,
                isExecutor
            },
            operations,
            deposits
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة التقرير' });
    }
});

module.exports = router;
