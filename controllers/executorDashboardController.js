const mongoose = require('mongoose');
const { logAction } = require('../services/auditService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const Admin = require('../models/Admin');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');

exports.getProxyImage = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('Not found');
        const emp = await Employee.findById(req.session.executorId);
        if (!emp || (tx.executorGroupId && tx.executorGroupId.toString() !== emp.groupId.toString() && (!tx.managerGroupId || tx.managerGroupId.toString() !== emp.groupId.toString()))) {
             return res.status(403).send('Forbidden');
        }
        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) { photoId = tx.proofImages[index]; }
        else if (tx.proofImage && index === 0) { photoId = tx.proofImage; }
        if (!photoId) return res.status(404).send('No photo');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) { console.error(error); res.status(500).send('Server error'); }
};

exports.getDashboard = async (req, res) => {
    const emp = await Employee.findById(req.session.executorId).populate('groupId');
    res.render('executor/dashboard', { emp });
};

// ===============================================
// 👥 إدارة الموظفين (للمدير فقط)
// ===============================================
exports.getEmployees = async (req, res) => {
    const emp = await Employee.findById(req.session.executorId).populate('groupId');
    res.render('executor/employees', { emp });
};

exports.getEmployeesList = async (req, res) => {
    try {
        const employees = await Employee.find({ groupId: req.managerEmp.groupId }).sort({ role: 1, createdAt: -1 }).lean();
        res.json({ success: true, employees });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.postEmployeesCreate = async (req, res) => {
    try {
        const { name, phone, role, webUsername, webPassword } = req.body;
        if (!name || !webUsername || !webPassword) return res.json({ success: false, error: 'Missing fields' });
        if (!['operator', 'accountant'].includes(role)) return res.json({ success: false, error: 'Invalid role' });
        const prefix = webUsername.replace(/@ahram\.com$/i, '').trim();
        if (!/^[a-zA-Z0-9_]+$/.test(prefix)) return res.json({ success: false, error: 'Invalid username' });
        const finalUsername = prefix + '@ahram.com';
        const existing = await Employee.findOne({ webUsername: finalUsername });
        if (existing) return res.json({ success: false, error: 'Username taken' });
        const createdEmp = await Employee.create({ name, phone: phone || '', role, status: 'active', groupId: req.managerEmp.groupId, webUsername: finalUsername, webPassword });
        
        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: req.session.executorId || (req.managerEmp ? req.managerEmp._id : null),
            performedByModel: 'Employee',
            performedByName: req.managerEmp ? req.managerEmp.name : 'مدير',
            targetId: createdEmp._id,
            targetModel: 'Employee',
            result: 'ناجح',
            metadata: { 
                role, 
                username: finalUsername, 
                actionLabel: role === 'accountant' ? 'انشاء حساب محاسب' : 'انشاء حساب موظف',
                name: name
            }
        });

        res.json({ success: true, username: finalUsername });
    } catch (e) { console.error(e); res.json({ success: false, error: e.message }); }
};

exports.postEmployeesToggle = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.groupId.toString() !== req.managerEmp.groupId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Cannot toggle manager' });
        emp.status = emp.status === 'active' ? 'suspended' : 'active';
        await emp.save();
        res.json({ success: true, newStatus: emp.status });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesToggleReports = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.groupId.toString() !== req.managerEmp.groupId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Manager always has access' });
        emp.canViewAllReports = !emp.canViewAllReports;
        await emp.save();
        res.json({ success: true, canViewAllReports: emp.canViewAllReports });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesResetPassword = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.groupId.toString() !== req.managerEmp.groupId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Not allowed' });
        emp.webPassword = req.body.newPassword;
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesDelete = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.groupId.toString() !== req.managerEmp.groupId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Cannot delete manager' });
        await Employee.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

// ===============================================
// 🚀 جلب الطلبات الحية + الإشعارات
// ===============================================
exports.getLiveTasks = async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const filter = {
            $or: [ { executorGroupId: emp.groupId }, { managerGroupId: emp.groupId } ],
            status: { $in: ['processing', 'accepted'] }
        };
        const tasks = await Transaction.find(filter).sort({ createdAt: 1 }).lean();

        for (let tx of tasks) {
            if (tx.status === 'processing' && !tx.notifiedExecutors) {
                try {
                    await Transaction.updateOne({ _id: tx._id }, { $set: { notifiedExecutors: true } }, { strict: false });
                } catch (e) {}
            }
        }

        const busyOperators = await Transaction.distinct('operatorId', {
            $or: [ { executorGroupId: emp.groupId }, { managerGroupId: emp.groupId } ],
            status: 'accepted', operatorId: { $ne: null }
        });
        const now = Date.now();
        for (let tx of tasks) {
            if (tx.status === 'processing' && !tx.autoAlertFired) {
                const diffMs = now - new Date(tx.createdAt).getTime();
                if (diffMs >= 120000) {
                    await Transaction.findOneAndUpdate(
                        { _id: tx._id, autoAlertFired: { $ne: true } },
                        { $set: { emergencyAlert: 'تأخير استجابة! الطلب تخطى 120 ثانية ولم يقبله أحد، يرجى سحبه فوراً!', autoAlertFired: true } },
                        { new: true, strict: false }
                    );
                }
            }
        }

        const alerts = await Transaction.find({
            $or: [ { executorGroupId: emp.groupId }, { managerGroupId: emp.groupId } ],
            emergencyAlert: { $exists: true, $ne: null },
            status: { $in: ['processing', 'accepted'] }
        }).lean();
        const depAlerts = await Transaction.find({
            $or: [ { operatorId: emp._id.toString() }, { executorGroupId: emp.groupId }, { managerGroupId: emp.groupId } ],
            executorWebAlert: { $exists: true, $ne: null }
        }).lean();

        // 🟢 جلب العمليات التي تم تنفيذها اليوم
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        let completedTodayQuery = {
            status: 'completed',
            updatedAt: { $gte: startOfToday }
        };

        if (emp.role === 'manager') {
            // المدير يرى كل عمليات المجموعة المنفذة اليوم
            completedTodayQuery.$or = [
                { executorGroupId: emp.groupId },
                { managerGroupId: emp.groupId }
            ];
        } else {
            // الموظف العادي يرى عملياته فقط
            completedTodayQuery.operatorId = emp._id.toString();
        }

        const completedToday = await Transaction.find(completedTodayQuery)
            .sort({ updatedAt: -1 })
            .select('customId amount transferType vodafoneNumber accountNumber updatedAt executorName')
            .lean();

        res.json({ tasks, alerts, depAlerts, completedToday });
    } catch (e) { res.status(500).json({ error: true }); }
};

exports.postClearAlert = async (req, res) => {
    try { await Transaction.updateOne({ _id: req.params.id }, { $unset: { emergencyAlert: 1 } }, { strict: false }); res.json({ success: true }); }
    catch (e) { res.json({ success: false }); }
};

exports.postClearDepAlert = async (req, res) => {
    try { await Transaction.updateOne({ _id: req.params.id }, { $unset: { executorWebAlert: 1 } }, { strict: false }); res.json({ success: true }); }
    catch (e) { res.json({ success: false }); }
};
