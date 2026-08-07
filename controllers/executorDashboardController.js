const mongoose = require('mongoose');
const { logAction } = require('../services/auditService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const { escapeRegex } = require('../utils/helpers');

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const Admin = require('../models/Admin');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const {
    ExecutorAccountError,
    normalizeExecutorPhone,
    normalizeExecutorUsername
} = require('../services/executorAccountService');

const objectIdString = (value) => String(value?._id || value || '');
const belongsToGroup = (employee, group) => (
    Boolean(employee) && objectIdString(employee.groupId) === objectIdString(group)
);

exports.getProxyImage = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('Not found');
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        const employeeGroupId = objectIdString(emp?.groupId);
        const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
        const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
        if (!emp || (!ownsExecutorTask && !ownsManagerTask)) {
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
    const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
    res.render('executor/dashboard', { emp });
};

// ===============================================
// 👥 إدارة الموظفين (للمدير فقط)
// ===============================================
exports.getEmployees = async (req, res) => {
    const emp = req.managerEmp || await Employee.findById(req.session.executorId).populate('groupId');
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
        const cleanName = String(name || '').trim();
        if (cleanName.length < 3 || !phone || !webUsername || !webPassword) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال جميع البيانات المطلوبة.' });
        }
        if (!['operator', 'accountant'].includes(role)) {
            return res.status(400).json({ success: false, error: 'نوع الحساب غير صالح.' });
        }
        if (String(webPassword).length < 6) {
            return res.status(400).json({ success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف.' });
        }

        const finalUsername = normalizeExecutorUsername(webUsername);
        const finalPhone = normalizeExecutorPhone(phone);
        const existing = await Employee.exists({ webUsername: new RegExp(`^${escapeRegex(finalUsername)}$`, 'i') });
        if (existing) return res.status(409).json({ success: false, error: 'اسم الدخول مستخدم بالفعل.' });
        const createdEmp = await Employee.create({
            name: cleanName,
            phone: finalPhone,
            role,
            status: 'active',
            groupId: req.managerEmp.groupId,
            webUsername: finalUsername,
            webPassword
        });
        
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

        return res.json({ success: true, username: finalUsername });
    } catch (e) {
        console.error(e);
        const message = e instanceof ExecutorAccountError ? e.message : 'تعذر إنشاء حساب الموظف.';
        return res.status(400).json({ success: false, error: message });
    }
};

exports.postEmployeesToggle = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Cannot toggle manager' });
        emp.status = emp.status === 'active' ? 'suspended' : 'active';
        await emp.save();
        res.json({ success: true, newStatus: emp.status });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesToggleReports = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Manager always has access' });
        emp.canViewAllReports = !emp.canViewAllReports;
        await emp.save();
        res.json({ success: true, canViewAllReports: emp.canViewAllReports });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesResetPassword = async (req, res) => {
    try {
        const newPassword = String(req.body.newPassword || '');
        if (newPassword.length < 6) return res.status(400).json({ success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف.' });
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Not allowed' });
        emp.webPassword = newPassword;
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesDelete = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن حذف موظف تابع لمنفذ آخر.' });
        }
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
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const filter = {
            $or: [ { executorGroupId: emp.groupId }, { managerGroupId: emp.groupId } ],
            status: { $in: ['processing', 'accepted'] }
        };
        const taskArrivalTime = (tx) => {
            const value = new Date(tx.executorReceivedAt || tx.createdAt || 0).getTime();
            return Number.isFinite(value) ? value : 0;
        };

        const tasks = await Transaction.find(filter).sort({ createdAt: 1 }).lean();
        tasks.sort((first, second) => taskArrivalTime(first) - taskArrivalTime(second));

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
                const diffMs = now - taskArrivalTime(tx);
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
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const result = await Transaction.updateOne({
            _id: req.params.id,
            $or: [{ executorGroupId: emp.groupId }, { managerGroupId: emp.groupId }]
        }, { $unset: { emergencyAlert: 1 } }, { strict: false });
        if (!result.matchedCount) return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل هذا التنبيه.' });
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: 'تعذر إغلاق التنبيه.' }); }
};

exports.postClearDepAlert = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const result = await Transaction.updateOne({
            _id: req.params.id,
            $or: [
                { operatorId: emp._id.toString() },
                { executorGroupId: emp.groupId },
                { managerGroupId: emp.groupId }
            ]
        }, { $unset: { executorWebAlert: 1 } }, { strict: false });
        if (!result.matchedCount) return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل هذا التنبيه.' });
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: 'تعذر إغلاق التنبيه.' }); }
};
