// routes/registrationRequests.js
// =====================================================
// 📋 إدارة طلبات التسجيل — Registration Requests Management
// =====================================================
const express = require('express');
const router = express.Router();
const RegistrationRequest = require('../models/RegistrationRequest');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const {
    CODE_LENGTHS,
    assignGeneratedAccountCode
} = require('../services/accountCodeService');
const { prepareRegistrationIdentityForApproval } = require('../services/registrationIdentityService');

const visibleRequestStatuses = new Set(['pending', 'pending_agent', 'approved', 'rejected']);
const appendAdminNote = (current, note) => [current, String(note || '').trim()].filter(Boolean).join('\n');

// ─────────────────────────────────────────────────
// 📋 عرض جميع طلبات التسجيل
// ─────────────────────────────────────────────────
router.get('/registration-requests', requireAuth, async (req, res) => {
    try {
        const statusFilter = visibleRequestStatuses.has(req.query.status) ? req.query.status : '';
        const filter = statusFilter
            ? { status: statusFilter }
            : { status: { $in: ['pending', 'pending_agent'] } };
        
        const [requests, pending, pendingAgent, approved, rejected, total] = await Promise.all([
            RegistrationRequest.find(filter).sort({ createdAt: -1 }).lean(),
            RegistrationRequest.countDocuments({ status: 'pending' }),
            RegistrationRequest.countDocuments({ status: 'pending_agent' }),
            RegistrationRequest.countDocuments({ status: 'approved' }),
            RegistrationRequest.countDocuments({ status: 'rejected' }),
            RegistrationRequest.countDocuments({ status: { $ne: 'deleted' } })
        ]);
        const counts = { pending, pendingAgent, approved, rejected, total };

        res.render('registration_requests', { 
            requests, 
            counts, 
            status: statusFilter || '',
            activePage: 'registration_requests',
            query: req.query 
        });
    } catch (error) {
        console.error('[RegistrationRequests] Error:', error.message);
        res.status(500).send('حدث خطأ في تحميل طلبات التسجيل');
    }
});

// ─────────────────────────────────────────────────
// ✅ قبول طلب تسجيل وإنشاء الحساب
// ─────────────────────────────────────────────────
router.post('/registration-requests/:id/approve', requireAuth, requireMaster, async (req, res) => {
    try {
        const regReq = await RegistrationRequest.findById(req.params.id);
        if (!regReq || regReq.status !== 'pending') {
            return res.redirect('/registration-requests?error=not_found');
        }

        const adminName = req.session.adminName || 'مدير';

        await prepareRegistrationIdentityForApproval({
            phone: regReq.phone || regReq.companyPhone,
            username: regReq.username,
            excludeRequestId: regReq._id
        });

        // ─── إنشاء الحساب حسب نوع الطلب ───
        if (regReq.accountType === 'direct') {
            // عميل مباشر → إنشاء حساب User
            await User.create({
                name: regReq.fullName,
                phone: regReq.phone,
                webUsername: regReq.username,
                webPassword: regReq.password, // مشفر مسبقاً في RegistrationRequest
                storeName: regReq.storeName,
                address: regReq.address,
                tier: 1,
                balance: 0,
                status: 'active',
                role: 'user'
            });

        } else if (regReq.accountType === 'new') {
            // عميل جديد (بدون متجر) → إنشاء حساب User
            const phoneUsername = String(regReq.phone || regReq._id).replace(/\D/g, '') || String(regReq._id);
            await User.create({
                name: regReq.fullName,
                phone: regReq.phone,
                webUsername: regReq.username || `${phoneUsername}@ahram.local`,
                nationality: regReq.nationality,
                city: regReq.city,
                webPassword: regReq.password,
                tier: 1,
                balance: 0,
                status: 'active',
                role: 'user'
            });

        } else if (regReq.accountType === 'company') {
            // شركة → إنشاء ClientCompany + ClientEmployee (مدير الشركة)
            const company = await ClientCompany.create({
                name: regReq.companyName,
                phone: regReq.companyPhone,
                tier: 3,
                balance: 0,
                status: 'active'
            });

            await ClientEmployee.create({
                name: regReq.companyContact || regReq.companyName,
                phone: regReq.companyPhone,
                companyId: company._id,
                webUsername: regReq.username,
                webPassword: regReq.password,
                role: 'owner',
                canViewAllReports: true,
                canManageCompany: true,
                canCreateCompanyStaff: true,
                status: 'active'
            });

        } else if (regReq.accountType === 'agent') {
            // وكيل منطقة → إنشاء حساب User بصلاحيات وكيل
            const agent = await User.create({
                name: regReq.fullName,
                phone: regReq.phone,
                webUsername: regReq.username,
                webPassword: regReq.password,
                storeName: regReq.companyName,
                address: regReq.address,
                tier: 2,
                balance: 0,
                status: 'active',
                role: 'agent'
            });
            const accountCode = await assignGeneratedAccountCode({
                Model: User,
                modelName: 'User',
                id: agent._id,
                length: CODE_LENGTHS.agent
            });
            agent.agentCode = accountCode;
            await agent.save();
            regReq.agentCode = accountCode;

        } else if (regReq.accountType === 'executor') {
            // منفذ → إنشاء ExecutorGroup + Employee (مدير)
            const newGroup = await ExecutorGroup.create({
                name: regReq.companyName,
                isManagerBot: true,
                isApiBot: false,
                status: 'active'
            });

            await Employee.create({
                name: regReq.fullName,
                phone: regReq.phone,
                role: 'manager',
                status: 'active',
                groupId: newGroup._id,
                webUsername: regReq.username,
                webPassword: regReq.password
            });
        }

        // تحديث حالة الطلب
        regReq.status = 'approved';
        regReq.reviewedBy = adminName;
        regReq.reviewedAt = new Date();
        await regReq.save();

        // تسجيل في Audit Log
        try {
            const { logAction } = require('../services/auditService');
            await logAction({
                action: 'REGISTRATION_APPROVED',
                performedBy: adminName,
                metadata: { 
                    requestId: regReq._id, 
                    refCode: regReq.refCode, 
                    accountType: regReq.accountType,
                    name: regReq.fullName || regReq.companyName
                }
            });
        } catch (e) { /* ignore audit errors */ }

        res.redirect('/registration-requests?success=approved');

    } catch (error) {
        console.error('[RegistrationRequests] Approve Error:', error.message);
        const duplicateIdentity = ['IDENTITY_PENDING', 'IDENTITY_TAKEN'].includes(error.message);
        res.redirect(`/registration-requests?error=${duplicateIdentity ? 'duplicate' : 'approve_failed'}`);
    }
});

// ─────────────────────────────────────────────────
// ❌ رفض طلب تسجيل
// ─────────────────────────────────────────────────
router.post('/registration-requests/:id/reject', requireAuth, requireMaster, async (req, res) => {
    try {
        const regReq = await RegistrationRequest.findById(req.params.id);
        if (!regReq || regReq.status !== 'pending') {
            return res.redirect('/registration-requests?error=not_found');
        }

        const adminName = req.session.adminName || 'مدير';

        regReq.status = 'rejected';
        regReq.reviewedBy = adminName;
        regReq.reviewedAt = new Date();
        regReq.adminNotes = appendAdminNote(regReq.adminNotes, req.body.notes || 'تم الرفض من الإدارة');
        await regReq.save();

        // تسجيل في Audit Log
        try {
            const { logAction } = require('../services/auditService');
            await logAction({
                action: 'REGISTRATION_REJECTED',
                performedBy: adminName,
                metadata: { 
                    requestId: regReq._id, 
                    refCode: regReq.refCode,
                    accountType: regReq.accountType
                }
            });
        } catch (e) { /* ignore audit errors */ }

        res.redirect('/registration-requests?success=rejected');

    } catch (error) {
        console.error('[RegistrationRequests] Reject Error:', error.message);
        res.redirect('/registration-requests?error=reject_failed');
    }
});

// حذف منطقي للطلب مع الاحتفاظ بسجل التدقيق
router.post('/registration-requests/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const regReq = await RegistrationRequest.findOne({
            _id: req.params.id,
            status: { $in: ['pending', 'pending_agent'] }
        });
        if (!regReq) return res.redirect('/registration-requests?error=not_found');

        const adminName = req.session.adminName || 'مدير';
        regReq.status = 'deleted';
        regReq.deletedBy = adminName;
        regReq.deletedAt = new Date();
        regReq.reviewedBy = adminName;
        regReq.reviewedAt = regReq.deletedAt;
        regReq.adminNotes = appendAdminNote(regReq.adminNotes, req.body.notes || 'تم حذف طلب الانضمام من الإدارة');
        await regReq.save();

        try {
            const { logAction } = require('../services/auditService');
            await logAction({
                action: 'REGISTRATION_DELETED',
                performedBy: adminName,
                metadata: {
                    requestId: regReq._id,
                    refCode: regReq.refCode,
                    accountType: regReq.accountType
                }
            });
        } catch (e) { /* ignore audit errors */ }

        return res.redirect('/registration-requests?success=deleted');
    } catch (error) {
        console.error('[RegistrationRequests] Delete Error:', error.message);
        return res.redirect('/registration-requests?error=delete_failed');
    }
});

module.exports = router;
