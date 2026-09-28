const Employee = require('../models/Employee');
const { snapshotCompanyBalances, workingBalanceForEmployee } = require('../services/executorBalancePoolService');

exports.getReports = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp) return res.redirect('/login');
        const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
        delete req.session.showMfaEnableNotice;
        const companyBalances = ['manager', 'accountant'].includes(emp.role)
            ? await snapshotCompanyBalances(emp.groupId).catch(() => null)
            : null;
        const workingBalance = emp.role === 'external'
            ? await workingBalanceForEmployee(emp).catch(() => null)
            : null;
        return res.render('executor/reports', { emp, showMfaNotice, companyBalances, workingBalance });
    } catch (e) { 
        res.redirect('/executor-portal/dashboard'); 
    }
};
