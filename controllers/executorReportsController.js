const Employee = require('../models/Employee');

exports.getReports = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp) return res.redirect('/login');
        return res.render('executor/reports', { emp });
    } catch (e) { 
        res.redirect('/executor-portal/dashboard'); 
    }
};
