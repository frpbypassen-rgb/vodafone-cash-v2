const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const { getTodayString } = require('../utils/helpers');

// Helper to get start/end dates
function getDateRange(dateStr, monthStr) {
    if (dateStr) {
        const start = new Date(dateStr); start.setHours(0, 0, 0, 0);
        const end = new Date(dateStr); end.setHours(23, 59, 59, 999);
        return { start, end };
    } else if (monthStr) {
        const [year, month] = monthStr.split('-');
        const start = new Date(year, parseInt(month) - 1, 1);
        const end = new Date(year, parseInt(month), 0, 23, 59, 59, 999);
        return { start, end };
    }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return { start, end };
}

const requireExecutorAuth = (req, res, next) => {
    if (req.session.isExecutorLoggedIn && req.session.executorId) return next();
    res.redirect('/executor-portal/login');
};

router.get('/reports', requireExecutorAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        res.render('executor/reports', { emp });
    } catch (e) { res.status(500).send('Error'); }
});

router.post('/reports/filter', requireExecutorAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ error: 'Unauthorized' });

        const { dateType, dateValue } = req.body;
        
                const isManager = emp.role === 'manager';
        const isAccountant = emp.role === 'accountant';
        const isEmployee = !isManager && !isAccountant;
        
        let finalDateType = dateType;
        let finalDateValue = dateValue;

        if (isEmployee) {
            // الموظف يرى دائماً اليوم فقط
            finalDateType = 'day';
            const today = new Date();
            finalDateValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        } else if (!isManager && !emp.canViewAllReports) {
            // المحاسب بدون صلاحية
            finalDateType = 'day';
            if (!finalDateValue) {
                const today = new Date();
                finalDateValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            }
        }

        let { start, end } = getDateRange(
            finalDateType === 'day' ? finalDateValue : null,
            finalDateType === 'month' ? finalDateValue : null
        );

        let baseQuery = {
            $or: [
                { executorGroupId: emp.groupId },
                { managerGroupId: emp.groupId }
            ]
        };

        if (isEmployee) {
            // المكتملة والملغية فقط
            baseQuery.status = { $in: ['completed', 'rejected', 'cancelled_by_admin', 'failed'] };
            
            // إذا لم يكن لديه صلاحية التقارير الشاملة، يرى عملياته فقط
            if (!emp.canViewAllReports) {
                baseQuery.operatorId = emp._id.toString();
            }
        } else {
            if (!isManager && !emp.canViewAllReports) {
                baseQuery.operatorId = emp._id.toString();
            }
        }

        // Transactions
        const currentTransactions = await Transaction.find({ ...baseQuery, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean();

        let totalLYD = 0; let totalEGP = 0;
        let completedCount = 0; let rejectedCount = 0;
        const operations = []; const deposits = []; // No deposits for executors usually, but we keep format

        currentTransactions.forEach(tx => {
            if (tx.status === 'completed') {
                totalLYD += (tx.costLYD || 0); // تكلفة للمنفذ؟
                totalEGP += (tx.amount || 0);
                completedCount++;
            } else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin') {
                rejectedCount++;
            }
            if (['deposit', 'deduction', 'deposit_pending'].includes(tx.status)) {
                deposits.push(tx);
            } else {
                operations.push(tx);
            }
        });

        // Previous balance calculation? Executor balance is global to group, omit for simplicity or set to 0.
        const previousBalance = 0;

        const entityInfo = {
            name: emp.name,
            phone: emp.phone || '---',
            username: emp.webUsername,
            joinDate: emp.createdAt,
            status: isManager ? 'مدير شركة تنفيذ' : 'موظف منفذ مالي'
        };

        res.json({
            success: true,
            data: {
                previousBalance,
                currentTransactions,
                operations,
                deposits,
                totalLYD,
                totalEGP,
                completedCount,
                rejectedCount,
                totalDeposits: 0,
                entityInfo
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

module.exports = router;
