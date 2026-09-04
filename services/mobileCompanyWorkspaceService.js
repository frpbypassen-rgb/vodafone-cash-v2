'use strict';

// Mobile company-workspace contract.  It intentionally owns only the
// company that belongs to the authenticated employee; clients must never be
// able to choose a company id in a request.
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { logAction } = require('./auditService');

const USERNAME_DOMAIN = '@ahram.com';

const normalizeUsername = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    const username = raw.includes('@') ? raw : `${raw}${USERNAME_DOMAIN}`;
    if (!/^[a-z0-9_]{3,40}@ahram\.com$/.test(username)) {
        const error = new Error('INVALID_USERNAME');
        error.code = 'INVALID_USERNAME';
        throw error;
    }
    return username;
};

const isOwner = (employee) => {
    const role = String(employee.role || '').toLowerCase();
    const isLegacyOwner = role !== 'accountant'
        && employee.canViewAllReports === true
        && employee.canManageCompany !== true;
    return role === 'owner' || employee.canCreateCompanyStaff === true || isLegacyOwner;
};

const canManageCompany = (employee) => isOwner(employee) || employee.canManageCompany === true;

const employeePermissions = (employee) => {
    const role = String(employee.role || '').toLowerCase();
    const permissions = [
        'client.home.read',
        'client.transfer.create',
        'client.transactions.read',
        'client.tickets.manage',
        'client.profile.read',
        'client.profile.update',
        'company.dashboard.read'
    ];
    if (isOwner(employee)) {
        permissions.push(
            'company.employees.read',
            'company.employees.create',
            'company.employees.update_status',
            'company.employees.update_permissions',
            'company.reports.read',
            'company.reports.read_all'
        );
    } else if (canManageCompany(employee)) {
        permissions.push(
            'company.employees.read',
            'company.employees.update_status',
            'company.employees.update_permissions',
            'company.reports.read',
            'company.reports.read_all'
        );
    } else if (role === 'accountant') {
        permissions.push('company.reports.read', 'company.reports.read_all');
    } else {
        permissions.push('company.reports.read_day');
    }
    return permissions;
};

const toEmployeeDto = (employee) => ({
    id: String(employee._id),
    name: employee.name || '',
    phone: employee.phone || '',
    username: employee.webUsername || '',
    role: isOwner(employee) ? 'owner' : (canManageCompany(employee) ? 'manager' : (employee.role || 'employee')),
    // Keep the mobile UI independent from legacy "banned" terminology.
    status: employee.status === 'active' ? 'active' : 'inactive',
    permissions: employeePermissions(employee),
    email: ''
});

const resolveCompanyActor = async (req) => {
    if (!req.user || req.user.accountType !== 'client_company') {
        const error = new Error('FORBIDDEN');
        error.code = 'FORBIDDEN';
        throw error;
    }

    const actor = await ClientEmployee.findById(req.user.userId);
    if (!actor || actor.status !== 'active') {
        const error = new Error('FORBIDDEN');
        error.code = 'FORBIDDEN';
        throw error;
    }
    const company = await ClientCompany.findById(actor.companyId);
    if (!company || company.status !== 'active') {
        const error = new Error('FORBIDDEN');
        error.code = 'FORBIDDEN';
        throw error;
    }
    if (req.tenant && actor.tenantId && String(actor.tenantId) !== String(req.tenant._id)) {
        const error = new Error('FORBIDDEN');
        error.code = 'FORBIDDEN';
        throw error;
    }
    return { actor, company };
};

const assertOwner = (actor) => {
    if (!isOwner(actor)) {
        const error = new Error('FORBIDDEN');
        error.code = 'FORBIDDEN';
        throw error;
    }
};

const assertUsernameAvailable = async (username) => {
    const matches = await Promise.all([
        ClientEmployee.exists({ webUsername: username }),
        User.exists({ webUsername: username }),
        SubAccount.exists({ webUsername: username }),
        AgentEmployee.exists({ webUsername: username }),
        Employee.exists({ webUsername: username }),
        Admin.exists({ webUsername: username })
    ]);
    if (matches.some(Boolean)) {
        const error = new Error('USERNAME_TAKEN');
        error.code = 'USERNAME_TAKEN';
        throw error;
    }
};

const listEmployees = async (req) => {
    const { company } = await resolveCompanyActor(req);
    const employees = await ClientEmployee.find({
        companyId: company._id,
        status: { $ne: 'deleted' }
    }).sort({ role: 1, createdAt: -1 }).lean();

    return employees.map(toEmployeeDto);
};

const createEmployee = async (req) => {
    const { actor, company } = await resolveCompanyActor(req);
    assertOwner(actor);

    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '').trim();
    const requestedRole = String(req.body.role || 'employee').trim().toLowerCase();
    const requestedPermissions = Array.isArray(req.body.permissions)
        ? req.body.permissions.map(String)
        : [];
    if (!name || !phone || !password || !['employee', 'accountant'].includes(requestedRole)) {
        const error = new Error('INVALID_INPUT');
        error.code = 'INVALID_INPUT';
        throw error;
    }
    if (password.length < 6) {
        const error = new Error('WEAK_PASSWORD');
        error.code = 'WEAK_PASSWORD';
        throw error;
    }
    const username = normalizeUsername(req.body.username);
    await assertUsernameAvailable(username);

    // Only the owner can delegate management.  "create" never grants owner
    // status, which keeps recovery of the company under the original owner.
    const grantManager = requestedRole === 'employee'
        && requestedPermissions.includes('company.employees.read');
    const employee = await ClientEmployee.create({
        companyId: company._id,
        tenantId: (req.tenant && req.tenant._id) || actor.tenantId || company.tenantId || undefined,
        name,
        phone,
        webUsername: username,
        webPassword: password,
        role: requestedRole,
        status: 'active',
        canManageCompany: grantManager,
        canCreateCompanyStaff: false,
        canViewAllReports: requestedRole === 'accountant'
            || grantManager
            || requestedPermissions.includes('company.reports.read_all')
    });

    await logAction({
        action: 'USER_CREATED',
        req,
        performedById: actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: actor.name,
        targetId: employee._id,
        targetModel: 'ClientEmployee',
        result: 'ناجح',
        metadata: { companyId: String(company._id), role: requestedRole, webUsername: username }
    });
    return toEmployeeDto(employee);
};

const findMutableEmployee = async (actor, company, id) => {
    const employee = await ClientEmployee.findOne({ _id: id, companyId: company._id });
    if (!employee || String(employee._id) === String(actor._id) || isOwner(employee)) {
        const error = new Error('NOT_FOUND');
        error.code = 'NOT_FOUND';
        throw error;
    }
    return employee;
};

const updateEmployeeStatus = async (req) => {
    const { actor, company } = await resolveCompanyActor(req);
    assertOwner(actor);
    const status = String(req.body.status || '').toLowerCase();
    if (!['active', 'inactive'].includes(status)) {
        const error = new Error('INVALID_INPUT');
        error.code = 'INVALID_INPUT';
        throw error;
    }
    const employee = await findMutableEmployee(actor, company, req.params.id);
    employee.status = status === 'active' ? 'active' : 'banned';
    // Invalidate any outstanding sessions when access is removed.
    employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
    await employee.save();
    await logAction({
        action: 'USER_STATUS_CHANGED', req,
        performedById: actor._id, performedByModel: 'ClientEmployee', performedByName: actor.name,
        targetId: employee._id, targetModel: 'ClientEmployee', result: employee.status,
        metadata: { companyId: String(company._id) }
    });
    return toEmployeeDto(employee);
};

const updateEmployeePermissions = async (req) => {
    const { actor, company } = await resolveCompanyActor(req);
    assertOwner(actor);
    const permissions = Array.isArray(req.body.permissions)
        ? [...new Set(req.body.permissions.map(String))]
        : null;
    if (!permissions) {
        const error = new Error('INVALID_INPUT');
        error.code = 'INVALID_INPUT';
        throw error;
    }
    const employee = await findMutableEmployee(actor, company, req.params.id);
    const isAccountant = String(employee.role || '') === 'accountant';
    employee.canManageCompany = !isAccountant && permissions.includes('company.employees.read');
    employee.canViewAllReports = isAccountant
        || employee.canManageCompany
        || permissions.includes('company.reports.read_all')
        || permissions.includes('company.reports.full');
    employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
    await employee.save();
    await logAction({
        action: 'USER_PERMISSIONS_CHANGED', req,
        performedById: actor._id, performedByModel: 'ClientEmployee', performedByName: actor.name,
        targetId: employee._id, targetModel: 'ClientEmployee', result: 'ناجح',
        metadata: { companyId: String(company._id), permissions }
    });
    return toEmployeeDto(employee);
};

module.exports = {
    listEmployees,
    createEmployee,
    updateEmployeeStatus,
    updateEmployeePermissions
};
