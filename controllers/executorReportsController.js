const Employee = require('../models/Employee');

exports.getReports = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp) return res.redirect('/login');
        const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
        delete req.session.showMfaEnableNotice;
        return res.render('executor/reports', { emp, showMfaNotice });
    } catch (e) { 
        res.redirect('/executor-portal/dashboard'); 
    }
};
