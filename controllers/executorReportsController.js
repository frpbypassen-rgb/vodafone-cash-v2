const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { escapeRegex } = require('../utils/helpers');

exports.getReports = async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        let targetDate = req.query.date;
        let showMonth = req.query.month === 'true';
        let search = req.query.search ? req.query.search.trim() : '';
        let dateLabel = '';
        
        let filter = { 
            $or: [
                { executorGroupId: emp.groupId._id },
                { managerGroupId: emp.groupId._id }
            ]
        };
        let start, end;

        if (showMonth) {
            const now = new Date();
            start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
            dateLabel = `شهر ${now.getMonth() + 1} لعام ${now.getFullYear()}`;
            targetDate = '';
        } else if (targetDate) {
            start = new Date(`${targetDate}T00:00:00.000Z`);
            end = new Date(`${targetDate}T23:59:59.999Z`);
            dateLabel = targetDate;
        } else if (!search) {
            const today = new Date();
            targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            start = new Date(`${targetDate}T00:00:00.000Z`);
            end = new Date(`${targetDate}T23:59:59.999Z`);
            dateLabel = targetDate;
        } else {
            targetDate = '';
            dateLabel = 'نتائج البحث';
        }

        if (start && end) {
            filter.updatedAt = { $gte: start, $lte: end };
        }
        
        filter.status = { $in: ['completed', 'deposit', 'deduction'] };

        if (search) {
            const safeSearch = escapeRegex(search);
            filter.$and = [
                {
                    $or: [
                        { customId: { $regex: safeSearch, $options: 'i' } },
                        { vodafoneNumber: { $regex: safeSearch, $options: 'i' } },
                        { accountNumber: { $regex: safeSearch, $options: 'i' } }
                    ]
                }
            ];
        }

        const allPeriodTxs = await Transaction.find(filter).sort({ updatedAt: 1 }).lean(); 

        let openingBalance = 0;
        if (start) {
            const txsBefore = await Transaction.find({ 
                $or: [ { executorGroupId: emp.groupId._id }, { managerGroupId: emp.groupId._id } ],
                status: { $in: ['completed', 'deposit', 'deduction'] }, 
                updatedAt: { $lt: start } 
            }).lean();
            
            txsBefore.forEach(tx => {
                if (tx.status === 'completed') openingBalance -= (tx.amount || 0);
                else if (tx.status === 'deposit') openingBalance += (tx.amount || 0);
                else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
            });
        }

        let totalCompleted = 0; let totalSettle = 0; let totalDeduction = 0; 
        let groupedDaysArray = [];
        
        if (showMonth && !search) {
            const daysMap = {};
            let currentRunningBalance = openingBalance;
            
            allPeriodTxs.forEach(tx => {
                if (tx.status === 'completed') totalCompleted += (tx.amount || 0);
                else if (tx.status === 'deposit') totalSettle += (tx.amount || 0);
                else if (tx.status === 'deduction') totalDeduction += Math.abs(tx.amount || 0);

                const d = new Date(tx.updatedAt);
                const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli' }).format(d);

                if (!daysMap[dateStr]) {
                    daysMap[dateStr] = {
                        dateStr: dateStr,
                        displayDate: new Intl.DateTimeFormat('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Tripoli' }).format(d),
                        transactions: [],
                        totalCompleted: 0,
                        totalSettle: 0,
                        totalDeduction: 0,
                        execCount: 0
                    };
                }
                daysMap[dateStr].transactions.push(tx);
                
                if (tx.status === 'completed') { daysMap[dateStr].totalCompleted += (tx.amount || 0); daysMap[dateStr].execCount++; }
                else if (tx.status === 'deposit') { daysMap[dateStr].totalSettle += (tx.amount || 0); }
                else if (tx.status === 'deduction') { daysMap[dateStr].totalDeduction += Math.abs(tx.amount || 0); }
            });

            const sortedDates = Object.keys(daysMap).sort(); 
            
            sortedDates.forEach(date => {
                let day = daysMap[date];
                day.openingBalance = currentRunningBalance; 
                day.closingBalance = currentRunningBalance + day.totalSettle - day.totalCompleted - day.totalDeduction;
                currentRunningBalance = day.closingBalance; 
                
                day.transactions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
                groupedDaysArray.push(day);
            });

            groupedDaysArray.reverse(); 
        } else {
            allPeriodTxs.forEach(t => {
                if (t.status === 'completed') totalCompleted += t.amount || 0;
                else if (t.status === 'deposit') totalSettle += t.amount || 0;
                else if (t.status === 'deduction') totalDeduction += Math.abs(t.amount || 0);
            });
            allPeriodTxs.reverse(); 
        }

        const closingBalance = openingBalance + totalSettle - totalCompleted - totalDeduction;

        res.render('executor/reports', { 
            emp, transactions: allPeriodTxs, targetDate, dateLabel, showMonth, search,
            totalCompleted, totalSettle, totalDeduction, closingBalance, openingBalance,
            groupedDaysArray 
        });
    } catch (e) { 
        res.redirect('/executor-portal/dashboard'); 
    }
};
