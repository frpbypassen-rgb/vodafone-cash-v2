'use strict';

const crypto = require('crypto');
const Employee = require('../models/Employee');
const ExecutorBalancePool = require('../models/ExecutorBalancePool');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const Transaction = require('../models/Transaction');

class ExecutorBalancePoolError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'ExecutorBalancePoolError';
        this.code = code;
        this.status = status;
    }
}

const objectIdString = (value) => String(value?._id || value || '');
const groupIdOf = (employee) => employee?.groupId?._id || employee?.groupId;
const isActiveRecord = (doc) => !doc?.archivedAt;
const cleanPoolName = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const activeEmployeeFilter = (groupId) => ({
    groupId,
    $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }]
});
const activePoolFilter = (groupId) => ({
    groupId,
    $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }]
});

const fail = (code, message, status = 400) => {
    throw new ExecutorBalancePoolError(code, message, status);
};

const parseAmount = (amount) => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        fail('INVALID_AMOUNT', 'أدخل مبلغًا صحيحًا أكبر من صفر.');
    }
    return Math.round(parsed * 100) / 100;
};

const uniqueIds = (values = []) => [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => objectIdString(value))
    .filter(Boolean))];

const managerGroupId = (manager) => {
    const groupId = groupIdOf(manager);
    if (!manager || manager.role !== 'manager' || !groupId) {
        fail('FORBIDDEN', 'إدارة مجموعات الرصيد متاحة لمدير شركة التنفيذ فقط.', 403);
    }
    return groupId;
};

const belongsToManagerGroup = (doc, groupId) => (
    Boolean(doc) && objectIdString(doc.groupId) === objectIdString(groupId)
);

const allocatedFromRows = ({ pools = [], employees = [] }) => {
    const pooledIds = new Set(pools.map((pool) => objectIdString(pool._id)));
    const poolTotal = pools.reduce((sum, pool) => sum + Number(pool.balance || 0), 0);
    const soloTotal = employees
        .filter((employee) => employee.role === 'external' && !pooledIds.has(objectIdString(employee.balancePoolId)))
        .reduce((sum, employee) => sum + Number(employee.balance || 0), 0);
    return poolTotal + soloTotal;
};

const snapshotFromParts = ({ group, pools = [], employees = [] }) => {
    const privateBalance = Number(group?.balance || 0);
    const allocatedBalance = allocatedFromRows({ pools, employees });
    return {
        groupId: objectIdString(group?._id),
        name: group?.name || '',
        privateBalance,
        allocatedBalance,
        totalBalance: privateBalance + allocatedBalance
    };
};

async function loadActiveExternalLedger(groupId) {
    const [pools, employees] = await Promise.all([
        ExecutorBalancePool.find(activePoolFilter(groupId)).select('_id name balance groupId').lean(),
        Employee.find({ ...activeEmployeeFilter(groupId), role: 'external' })
            .select('_id name phone webUsername status role balance balancePoolId groupId')
            .lean()
    ]);
    return { pools, employees };
}

async function loadAllocatedByGroupIds(groupIds = []) {
    const ids = uniqueIds(groupIds);
    const allocated = new Map(ids.map((id) => [id, 0]));
    if (!ids.length) return allocated;

    const [pools, employees] = await Promise.all([
        ExecutorBalancePool.find({
            groupId: { $in: ids },
            $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }]
        }).select('groupId balance').lean(),
        Employee.find({
            groupId: { $in: ids },
            role: 'external',
            $and: [
                { $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] },
                { $or: [{ balancePoolId: null }, { balancePoolId: { $exists: false } }] }
            ]
        }).select('groupId balance').lean()
    ]);

    pools.forEach((pool) => {
        const key = objectIdString(pool.groupId);
        allocated.set(key, (allocated.get(key) || 0) + Number(pool.balance || 0));
    });
    employees.forEach((employee) => {
        const key = objectIdString(employee.groupId);
        allocated.set(key, (allocated.get(key) || 0) + Number(employee.balance || 0));
    });
    return allocated;
}

async function snapshotCompanyBalances(groupId) {
    const group = await ExecutorGroup.findById(groupId).select('name balance').lean();
    if (!group) fail('GROUP_NOT_FOUND', 'مجموعة التنفيذ غير موجودة.', 404);
    const ledger = await loadActiveExternalLedger(group._id);
    return snapshotFromParts({ group, ...ledger });
}

const decorateExternalEmployee = (employee, poolsById) => {
    const pool = employee.balancePoolId ? poolsById.get(objectIdString(employee.balancePoolId)) : null;
    const workingBalance = pool ? Number(pool.balance || 0) : Number(employee.balance || 0);
    return {
        ...employee,
        balance: workingBalance,
        soloBalance: Number(employee.balance || 0),
        workingBalance,
        balanceMembership: pool ? 'pool' : 'solo',
        balancePool: pool ? {
            id: objectIdString(pool._id),
            name: pool.name,
            balance: Number(pool.balance || 0)
        } : null
    };
};

function serializePool(pool, members = []) {
    return {
        id: objectIdString(pool._id),
        name: pool.name,
        balance: Number(pool.balance || 0),
        memberCount: members.length,
        members: members.map((member) => ({
            id: objectIdString(member._id),
            name: member.name,
            phone: member.phone || '',
            webUsername: member.webUsername || '',
            status: member.status
        }))
    };
}

async function listExternalBalanceWorkspace({ manager }) {
    const groupId = managerGroupId(manager);
    const group = await ExecutorGroup.findById(groupId).select('name balance').lean();
    if (!group) fail('GROUP_NOT_FOUND', 'مجموعة التنفيذ غير موجودة.', 404);
    const { pools, employees } = await loadActiveExternalLedger(groupId);
    const poolsById = new Map(pools.map((pool) => [objectIdString(pool._id), pool]));
    const membersByPool = new Map(pools.map((pool) => [objectIdString(pool._id), []]));
    const solos = [];

    employees.forEach((employee) => {
        const poolId = objectIdString(employee.balancePoolId);
        if (poolId && membersByPool.has(poolId)) {
            membersByPool.get(poolId).push(employee);
        } else {
            solos.push(employee);
        }
    });

    return {
        balances: snapshotFromParts({ group, pools, employees }),
        pools: pools.map((pool) => serializePool(pool, membersByPool.get(objectIdString(pool._id)) || [])),
        solos: solos.map((employee) => decorateExternalEmployee(employee, poolsById)),
        employees: employees.map((employee) => decorateExternalEmployee(employee, poolsById))
    };
}

async function workingBalanceForEmployee(employee) {
    if (!employee || employee.role !== 'external') {
        return { kind: 'none', balance: null, pool: null };
    }
    const poolId = employee.balancePoolId;
    if (poolId) {
        const pool = await ExecutorBalancePool.findById(poolId).lean();
        if (pool && isActiveRecord(pool) && belongsToManagerGroup(pool, groupIdOf(employee))) {
            return {
                kind: 'pool',
                balance: Number(pool.balance || 0),
                pool: { id: objectIdString(pool._id), name: pool.name }
            };
        }
    }
    return {
        kind: 'solo',
        balance: Number(employee.balance || 0),
        pool: null
    };
}

async function assertUniquePoolName({ groupId, name, excludeId = null }) {
    const existing = await ExecutorBalancePool.findOne({
        ...activePoolFilter(groupId),
        name,
        ...(excludeId ? { _id: { $ne: excludeId } } : {})
    }).select('_id').lean();
    if (existing) fail('POOL_NAME_TAKEN', 'يوجد مجموعة رصيد بنفس الاسم داخل شركة التنفيذ.');
}

async function loadOwnedPool({ manager, poolId }) {
    const groupId = managerGroupId(manager);
    const pool = await ExecutorBalancePool.findById(poolId);
    if (!pool || !isActiveRecord(pool) || !belongsToManagerGroup(pool, groupId)) {
        fail('POOL_NOT_FOUND', 'مجموعة الرصيد غير موجودة.', 404);
    }
    return { groupId, pool };
}

async function loadExternalEmployees({ groupId, memberIds }) {
    const ids = uniqueIds(memberIds);
    if (!ids.length) return [];
    const employees = await Employee.find({
        _id: { $in: ids },
        ...activeEmployeeFilter(groupId)
    });
    if (employees.length !== ids.length) {
        fail('EMPLOYEE_NOT_FOUND', 'أحد المنفذين الخارجيين غير موجود أو لا يتبع هذه الشركة.', 404);
    }
    employees.forEach((employee) => {
        if (employee.role !== 'external') {
            fail('INVALID_MEMBER', 'يمكن ربط المنفذين الخارجيين فقط بمجموعة رصيد مشتركة.');
        }
    });
    return employees;
}

async function attachEmployeesToPool({ pool, employees }) {
    let incomingSolo = 0;
    for (const employee of employees) {
        const currentPoolId = objectIdString(employee.balancePoolId);
        if (currentPoolId && currentPoolId !== objectIdString(pool._id)) {
            fail('ALREADY_IN_POOL', `«${employee.name}» مرتبط بمجموعة رصيد أخرى. افصله أولاً ثم أضفه.`);
        }
        if (!currentPoolId) {
            incomingSolo += Number(employee.balance || 0);
            employee.balance = 0;
            employee.balancePoolId = pool._id;
            await employee.save();
        }
    }
    if (incomingSolo) {
        const updated = await ExecutorBalancePool.findByIdAndUpdate(
            pool._id,
            { $inc: { balance: incomingSolo } },
            { new: true }
        );
        if (!updated) fail('POOL_NOT_FOUND', 'مجموعة الرصيد غير موجودة.', 404);
        pool.balance = updated.balance;
    }
    return pool;
}

async function createPool({ manager, name, memberIds = [] }) {
    const groupId = managerGroupId(manager);
    const poolName = cleanPoolName(name);
    if (poolName.length < 2) fail('INVALID_NAME', 'أدخل اسمًا واضحًا لمجموعة الرصيد (حرفان على الأقل).');
    await assertUniquePoolName({ groupId, name: poolName });
    const members = await loadExternalEmployees({ groupId, memberIds });
    const pool = await ExecutorBalancePool.create({
        name: poolName,
        groupId,
        balance: 0,
        tenantId: manager.tenantId || undefined
    });
    await attachEmployeesToPool({ pool, employees: members });
    return serializePool(pool, members);
}

async function renamePool({ manager, poolId, name }) {
    const { groupId, pool } = await loadOwnedPool({ manager, poolId });
    const poolName = cleanPoolName(name);
    if (poolName.length < 2) fail('INVALID_NAME', 'أدخل اسمًا واضحًا لمجموعة الرصيد (حرفان على الأقل).');
    await assertUniquePoolName({ groupId, name: poolName, excludeId: pool._id });
    pool.name = poolName;
    await pool.save();
    return serializePool(pool);
}

async function attachMembers({ manager, poolId, memberIds = [] }) {
    const { groupId, pool } = await loadOwnedPool({ manager, poolId });
    const members = await loadExternalEmployees({ groupId, memberIds });
    if (!members.length) fail('NO_MEMBERS', 'اختر منفذًا خارجيًا واحدًا على الأقل.');
    await attachEmployeesToPool({ pool, employees: members });
    return listExternalBalanceWorkspace({ manager });
}

async function detachMember({ manager, poolId, employeeId }) {
    const { groupId, pool } = await loadOwnedPool({ manager, poolId });
    const employee = await Employee.findById(employeeId);
    if (!employee || !belongsToManagerGroup(employee, groupId) || employee.role !== 'external') {
        fail('EMPLOYEE_NOT_FOUND', 'المنفذ الخارجي غير موجود ضمن هذه الشركة.', 404);
    }
    if (objectIdString(employee.balancePoolId) !== objectIdString(pool._id)) {
        fail('NOT_IN_POOL', 'هذا المنفذ غير مرتبط بهذه المجموعة.');
    }

    const remaining = await Employee.countDocuments({
        ...activeEmployeeFilter(groupId),
        role: 'external',
        balancePoolId: pool._id,
        _id: { $ne: employee._id }
    });

    employee.balancePoolId = null;
    if (remaining === 0) {
        const poolBalance = Number(pool.balance || 0);
        employee.balance = Number(employee.balance || 0) + poolBalance;
        if (poolBalance) {
            const updated = await ExecutorBalancePool.findOneAndUpdate(
                { _id: pool._id, balance: { $gte: poolBalance } },
                { $inc: { balance: -poolBalance } },
                { new: true }
            );
            if (!updated) fail('POOL_BALANCE_CHANGED', 'تعذر نقل رصيد المجموعة. أعد المحاولة.');
            pool.balance = updated.balance;
        }
    } else {
        employee.balance = 0;
    }
    await employee.save();
    return listExternalBalanceWorkspace({ manager });
}

async function archivePool({ manager, poolId }) {
    const { groupId, pool } = await loadOwnedPool({ manager, poolId });
    const memberCount = await Employee.countDocuments({
        ...activeEmployeeFilter(groupId),
        role: 'external',
        balancePoolId: pool._id
    });
    if (memberCount) fail('POOL_HAS_MEMBERS', 'افصل كل المنفذين من المجموعة قبل أرشفتها.');
    if (Number(pool.balance || 0) > 0) {
        fail('POOL_HAS_BALANCE', 'انقل رصيد المجموعة إلى منفذ فردي بفصل آخر عضو قبل الأرشفة.');
    }
    pool.archivedAt = new Date();
    pool.archivedBy = objectIdString(manager._id);
    await pool.save();
    return listExternalBalanceWorkspace({ manager });
}

async function detachEmployeeOnArchive(employee) {
    if (!employee?.balancePoolId || employee.role !== 'external') return employee;
    const fakeManager = { role: 'manager', groupId: employee.groupId, _id: employee._id, tenantId: employee.tenantId };
    try {
        await detachMember({ manager: fakeManager, poolId: employee.balancePoolId, employeeId: employee._id });
        const refreshed = await Employee.findById(employee._id);
        return refreshed || employee;
    } catch (_) {
        return employee;
    }
}

async function fundExternalExecutor({ manager, employeeId, type, amount, note = '' }) {
    const groupId = managerGroupId(manager);
    if (!['deposit', 'deduction'].includes(type)) {
        fail('INVALID_TYPE', 'نوع العملية غير صالح.');
    }
    const parsedAmount = parseAmount(amount);
    const employee = await Employee.findById(employeeId);
    if (!employee || !belongsToManagerGroup(employee, groupId)) {
        fail('EMPLOYEE_NOT_FOUND', 'الموظف غير موجود.', 404);
    }
    if (employee.role !== 'external') {
        fail('INVALID_MEMBER', 'هذا الإجراء مخصص للمنفذين الخارجيين فقط.');
    }

    const group = await ExecutorGroup.findById(groupId);
    if (!group) fail('GROUP_NOT_FOUND', 'مجموعة التنفيذ غير موجودة.', 404);

    const pool = employee.balancePoolId
        ? await ExecutorBalancePool.findById(employee.balancePoolId)
        : null;
    if (employee.balancePoolId && (!pool || !isActiveRecord(pool) || !belongsToManagerGroup(pool, groupId))) {
        fail('POOL_NOT_FOUND', 'مجموعة الرصيد المرتبطة بهذا المنفذ غير صالحة.', 404);
    }

    const creditTarget = pool || employee;
    const creditLabel = pool ? `مجموعة «${pool.name}»` : employee.name;

    if (type === 'deposit') {
        const updatedGroup = await ExecutorGroup.findOneAndUpdate(
            { _id: group._id, balance: { $gte: parsedAmount } },
            { $inc: { balance: -parsedAmount } },
            { new: true }
        );
        if (!updatedGroup) fail('INSUFFICIENT_PRIVATE_BALANCE', 'الرصيد الخاص للشركة غير كافٍ لإتمام الإيداع.');
        group.balance = updatedGroup.balance;
        try {
            if (pool) {
                const updatedPool = await ExecutorBalancePool.findByIdAndUpdate(
                    pool._id,
                    { $inc: { balance: parsedAmount } },
                    { new: true }
                );
                pool.balance = updatedPool.balance;
            } else {
                const updatedEmployee = await Employee.findByIdAndUpdate(
                    employee._id,
                    { $inc: { balance: parsedAmount } },
                    { new: true }
                );
                employee.balance = updatedEmployee.balance;
            }
        } catch (error) {
            await ExecutorGroup.findByIdAndUpdate(group._id, { $inc: { balance: parsedAmount } }).catch(() => {});
            throw error;
        }
    } else {
        const currentCredit = Number(creditTarget.balance || 0);
        if (currentCredit < parsedAmount) {
            fail('INSUFFICIENT_EXECUTOR_BALANCE', `رصيد ${creditLabel} غير كافٍ للخصم.`);
        }
        if (pool) {
            const updatedPool = await ExecutorBalancePool.findOneAndUpdate(
                { _id: pool._id, balance: { $gte: parsedAmount } },
                { $inc: { balance: -parsedAmount } },
                { new: true }
            );
            if (!updatedPool) fail('INSUFFICIENT_EXECUTOR_BALANCE', `رصيد ${creditLabel} غير كافٍ للخصم.`);
            pool.balance = updatedPool.balance;
        } else {
            const updatedEmployee = await Employee.findOneAndUpdate(
                { _id: employee._id, balance: { $gte: parsedAmount } },
                { $inc: { balance: -parsedAmount } },
                { new: true }
            );
            if (!updatedEmployee) fail('INSUFFICIENT_EXECUTOR_BALANCE', `رصيد ${creditLabel} غير كافٍ للخصم.`);
            employee.balance = updatedEmployee.balance;
        }
        const updatedGroup = await ExecutorGroup.findByIdAndUpdate(
            group._id,
            { $inc: { balance: parsedAmount } },
            { new: true }
        );
        group.balance = updatedGroup.balance;
    }

    const customId = `EXT-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const actionLabel = type === 'deposit' ? 'إيداع' : 'خصم';
    const poolNote = pool ? ` — رصيد مجموعة «${pool.name}»` : '';
    const tx = await Transaction.create({
        customId,
        userId: 'external-employee',
        executorGroupId: groupId,
        managerGroupId: groupId,
        operatorId: objectIdString(employee._id),
        executorName: employee.name,
        employeeName: employee.name,
        amount: parsedAmount,
        costLYD: 0,
        status: type,
        notes: String(note || '').trim().slice(0, 1000),
        adminNotes: `${actionLabel} منفذ خارجي (${employee.name})${poolNote} بواسطة المدير`,
        companyName: 'منفذ خارجي',
        vodafoneNumber: '---',
        transferType: 'external_balance',
        executorWebAlert: {
            type: type === 'deposit' ? 'success' : 'error',
            text: `تم ${actionLabel} ${parsedAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م ${type === 'deposit' ? 'إلى' : 'من'} ${pool ? `رصيد مجموعة «${pool.name}»` : 'رصيدك'} بواسطة مدير شركة التنفيذ.`
        }
    });

    if (employee.webUsername) {
        await Notification.create({
            userId: employee.webUsername,
            audience: 'executor',
            targetModel: 'Employee',
            targetId: employee._id,
            type,
            title: type === 'deposit' ? 'إيداع رصيد' : 'خصم رصيد',
            message: `تم ${actionLabel} ${parsedAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م ${pool ? `على رصيد مجموعة «${pool.name}»` : 'على رصيدك'}. رقم الحركة: ${customId}`,
            txId: customId,
            metadata: {
                transferType: 'external_balance',
                recipientOnly: true,
                recipientId: objectIdString(employee._id),
                poolId: pool ? objectIdString(pool._id) : null
            }
        }).catch(() => null);
    }

    const working = await workingBalanceForEmployee(employee);
    return {
        customId,
        transactionId: objectIdString(tx._id),
        companyPrivateBalance: Number(group.balance || 0),
        companyTotalBalance: Number(group.balance || 0) + (await loadAllocatedByGroupIds([groupId])).get(objectIdString(groupId)),
        employeeBalance: working.balance,
        workingBalance: working.balance,
        membership: working.kind,
        pool: working.pool,
        recipientId: objectIdString(employee._id)
    };
}

module.exports = {
    ExecutorBalancePoolError,
    allocatedFromRows,
    archivePool,
    attachMembers,
    createPool,
    decorateExternalEmployee,
    detachEmployeeOnArchive,
    detachMember,
    fundExternalExecutor,
    listExternalBalanceWorkspace,
    loadAllocatedByGroupIds,
    renamePool,
    snapshotCompanyBalances,
    snapshotFromParts,
    workingBalanceForEmployee
};
