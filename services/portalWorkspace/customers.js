'use strict';

const SubAccount = require('../../models/SubAccount');
const Transaction = require('../../models/Transaction');
const RegistrationRequest = require('../../models/RegistrationRequest');
const { resolveMarginPiasters } = require('../../utils/agencyPricing');
const { calculateCreditState } = require('../agencyCreditLimitService');
const { safeNumber, resolveDateRange, escapeRegex } = require('./primitives');
const { ownershipFilter, staffModelForWorkspace, staffOwnerFilter } = require('./transactions');

const loadCustomers = async (workspace) => {
    const customers = await SubAccount.find({
        masterType: workspace.masterType,
        masterId: workspace.masterId,
        status: { $ne: 'deleted' },
    })
        .sort({ createdAt: -1 })
        .lean();

    const customerIds = customers.map((customer) => customer._id);
    const month = resolveDateRange({});
    const stats = customerIds.length
        ? await Transaction.aggregate([
              {
                  $match: {
                      subAccountId: { $in: customerIds },
                      createdAt: { $gte: month.start, $lte: month.end },
                  },
              },
              {
                  $group: {
                      _id: '$subAccountId',
                      transactionCount: { $sum: 1 },
                      completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                      totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                      totalLYD: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$costLYD', 0] } },
                      lastActivity: { $max: '$createdAt' },
                  },
              },
          ])
        : [];
    const statsById = new Map(stats.map((item) => [String(item._id), item]));
    const enrichedCustomers = customers.map((customer) => {
        const creditState = calculateCreditState(customer);
        return {
            ...customer,
            ...creditState,
            positiveBalance: Math.max(0, creditState.balance),
            marginPiasters: resolveMarginPiasters(customer, 'vodafone'),
            stats: statsById.get(String(customer._id)) || {
                transactionCount: 0,
                completedCount: 0,
                totalEGP: 0,
                totalLYD: 0,
                lastActivity: null,
            },
        };
    });
    const pendingRequests = workspace.isAgent
        ? await RegistrationRequest.find({
              accountType: 'new',
              status: 'pending_agent',
              agentId: workspace.entity._id,
          })
              .sort({ createdAt: -1 })
              .lean()
        : [];

    return {
        customers: enrichedCustomers,
        pendingRequests,
        customerSummary: {
            total: customers.length,
            active: customers.filter((customer) => customer.status === 'active').length,
            totalBalance: enrichedCustomers.reduce((sum, customer) => sum + customer.balance, 0),
            positiveBalances: enrichedCustomers.reduce((sum, customer) => sum + customer.positiveBalance, 0),
            totalDebt: enrichedCustomers.reduce((sum, customer) => sum + customer.debt, 0),
            totalCredit: enrichedCustomers.reduce((sum, customer) => sum + customer.creditLimit, 0),
            monthVolumeEGP: stats.reduce((sum, item) => sum + safeNumber(item.totalEGP), 0),
        },
        periodLabel: month.label,
    };
};

const loadStaff = async (workspace, query = {}) => {
    const StaffModel = staffModelForWorkspace(workspace);
    const search = String(query.search || '')
        .trim()
        .slice(0, 80);
    const status = ['active', 'inactive'].includes(String(query.status || '')) ? String(query.status) : '';
    const role = ['employee', 'accountant', 'manager'].includes(String(query.role || ''))
        ? String(query.role)
        : '';
    const conditions = [staffOwnerFilter(workspace)];
    if (search) {
        const regex = new RegExp(escapeRegex(search), 'i');
        conditions.push({ $or: [{ name: regex }, { phone: regex }, { webUsername: regex }] });
    }
    if (status)
        conditions.push({
            status: workspace.isAgent && status === 'inactive' ? { $in: ['inactive', 'banned'] } : status,
        });
    if (role === 'manager')
        conditions.push({ $or: [{ role: 'owner' }, { canManageCompany: true }, { canManageAgent: true }] });
    else if (role) conditions.push({ role });
    const staffFilter = conditions.length === 1 ? conditions[0] : { $and: conditions };
    const staff = await StaffModel.find(staffFilter).sort({ role: 1, createdAt: -1 }).lean();
    const ownership = await ownershipFilter(workspace);
    const month = resolveDateRange({});
    const employeeNames = staff.map((member) => member.name).filter(Boolean);
    const stats = employeeNames.length
        ? await Transaction.aggregate([
              {
                  $match: {
                      $and: [
                          ownership,
                          { employeeName: { $in: employeeNames } },
                          { createdAt: { $gte: month.start, $lte: month.end } },
                      ],
                  },
              },
              {
                  $group: {
                      _id: '$employeeName',
                      transactionCount: { $sum: 1 },
                      completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                      totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                      lastActivity: { $max: '$createdAt' },
                  },
              },
          ])
        : [];
    const statsByName = new Map(stats.map((item) => [item._id, item]));
    return {
        staff: staff.map((member) => ({
            ...member,
            stats: statsByName.get(member.name) || {
                transactionCount: 0,
                completedCount: 0,
                totalEGP: 0,
                lastActivity: null,
            },
        })),
        staffSummary: {
            total: staff.length,
            active: staff.filter((member) => member.status === 'active').length,
            managers: staff.filter(
                (member) => member.role === 'owner' || member.canManageCompany || member.canManageAgent
            ).length,
            accountants: staff.filter((member) => member.role === 'accountant').length,
            monthOperations: stats.reduce((sum, item) => sum + safeNumber(item.transactionCount), 0),
        },
        periodLabel: month.label,
        staffFilters: { search, status, role },
    };
};

module.exports = { loadCustomers, loadStaff };
