'use strict';

const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const CompanyProfile = require('../models/CompanyProfile');
const { CORPORATE_ROLES } = require('./corporateRoleService');

class CorporateOnboardingError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const enableCompanyPortal = async ({ companyId, brandingName, sharedDailyLimit, defaultEmployeeApprovalLimit, defaultManagerApprovalLimit, tenantId }) => {
    const company = await ClientCompany.findById(companyId);
    if (!company) throw new CorporateOnboardingError('COMPANY_NOT_FOUND', 'الشركة غير موجودة.');

    company.corporatePortal = {
        enabled: true,
        brandingName: brandingName || company.name,
        sharedDailyLimit: Number(sharedDailyLimit) || 0,
        defaultEmployeeApprovalLimit: Number(defaultEmployeeApprovalLimit) || 0,
        defaultManagerApprovalLimit: Number(defaultManagerApprovalLimit) || 0
    };
    await company.save();

    const profile = await CompanyProfile.findOneAndUpdate(
        { companyId: company._id },
        {
            $set: {
                brandingName: company.corporatePortal.brandingName,
                enabled: true,
                sharedDailyLimit: company.corporatePortal.sharedDailyLimit,
                defaultEmployeeApprovalLimit: company.corporatePortal.defaultEmployeeApprovalLimit,
                defaultManagerApprovalLimit: company.corporatePortal.defaultManagerApprovalLimit,
                tenantId: tenantId || company.tenantId
            }
        },
        { upsert: true, new: true }
    );

    return { company, profile };
};

const assignCorporateRole = async ({ employeeId, companyId, corporateRole, approvalLimit, enabled = true }) => {
    if (!CORPORATE_ROLES.includes(corporateRole)) {
        throw new CorporateOnboardingError('INVALID_ROLE', 'الدور يجب أن يكون manager أو employee أو accountant.');
    }
    const employee = await ClientEmployee.findOne({ _id: employeeId, companyId });
    if (!employee) throw new CorporateOnboardingError('EMPLOYEE_NOT_FOUND', 'الموظف لا يخص هذه الشركة.');

    employee.corporateRole = corporateRole;
    employee.corporatePortalEnabled = enabled !== false;
    if (approvalLimit !== undefined && approvalLimit !== null && approvalLimit !== '') {
        employee.approvalLimit = Number(approvalLimit);
    }
    await employee.save();

    await CompanyProfile.updateOne(
        { companyId },
        { $addToSet: { linkedUserIds: employee._id } }
    );

    return employee;
};

module.exports = {
    CorporateOnboardingError,
    enableCompanyPortal,
    assignCorporateRole
};
