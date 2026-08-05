'use strict';

const DIRECTORY_SECTIONS = Object.freeze(['users', 'companies', 'agents', 'subaccounts']);
const DEFAULT_SECTION = 'users';
const DEFAULT_PAGE_SIZE = 24;

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeSection = (value) => (
    DIRECTORY_SECTIONS.includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : DEFAULT_SECTION
);

const normalizeSearch = (value) => String(value || '').trim().slice(0, 120);

const normalizePage = (value) => {
    const page = Number.parseInt(value, 10);
    return Number.isInteger(page) && page > 0 ? page : 1;
};

const buildSectionFilter = (section, search = '', extraMasterIds = []) => {
    const activeSection = normalizeSection(section);
    const filter = { status: { $ne: 'deleted' } };

    if (activeSection === 'users') filter.role = { $ne: 'agent' };
    if (activeSection === 'agents') filter.role = 'agent';

    const normalizedSearch = normalizeSearch(search);
    if (!normalizedSearch) return filter;

    const term = new RegExp(escapeRegex(normalizedSearch), 'i');
    const searchableFields = {
        users: ['name', 'phone', 'webUsername', 'accountCode'],
        companies: ['name', 'phone', 'accountCode'],
        agents: ['name', 'phone', 'webUsername', 'accountCode', 'agentCode'],
        subaccounts: ['name', 'phone', 'webUsername', 'accountCode']
    };

    filter.$or = searchableFields[activeSection].map((field) => ({ [field]: term }));
    if (activeSection === 'subaccounts' && extraMasterIds.length) {
        filter.$or.push({ masterId: { $in: extraMasterIds } });
    }

    return filter;
};

const findMatchingMasterIds = async ({ User, ClientCompany }, search) => {
    const normalizedSearch = normalizeSearch(search);
    if (!normalizedSearch) return [];

    const term = new RegExp(escapeRegex(normalizedSearch), 'i');
    const visible = { status: { $ne: 'deleted' }, name: term };
    const [users, companies] = await Promise.all([
        User.find(visible).select('_id').lean(),
        ClientCompany.find(visible).select('_id').lean()
    ]);

    return [...users, ...companies].map((record) => record._id);
};

const attachMasterNames = async ({ User, ClientCompany }, subAccounts) => {
    if (!subAccounts.length) return subAccounts;

    const userIds = [];
    const companyIds = [];
    subAccounts.forEach((subAccount) => {
        if (subAccount.masterType === 'user') userIds.push(subAccount.masterId);
        if (subAccount.masterType === 'company') companyIds.push(subAccount.masterId);
    });

    const [users, companies] = await Promise.all([
        userIds.length
            ? User.find({ _id: { $in: userIds }, status: { $ne: 'deleted' } }).select('name').lean()
            : [],
        companyIds.length
            ? ClientCompany.find({ _id: { $in: companyIds }, status: { $ne: 'deleted' } }).select('name').lean()
            : []
    ]);
    const masterNames = new Map(
        [...users, ...companies].map((record) => [String(record._id), record.name])
    );

    return subAccounts.map((subAccount) => ({
        ...subAccount,
        masterName: masterNames.get(String(subAccount.masterId)) || 'غير معروف'
    }));
};

const modelForSection = ({ User, ClientCompany, SubAccount }, section) => {
    if (section === 'companies') return ClientCompany;
    if (section === 'subaccounts') return SubAccount;
    return User;
};

const fieldsForSection = (section) => {
    if (section === 'companies') return 'name phone tier balance accountCode token status createdAt';
    if (section === 'subaccounts') {
        return 'masterType masterId name phone webUsername balance accountCode creditLimit status createdAt';
    }
    return 'name phone tier balance accountCode agentCode webUsername role status createdAt';
};

const loadAdminAccountDirectory = async ({ User, ClientCompany, SubAccount }, query = {}) => {
    const activeSection = normalizeSection(query.section);
    const search = normalizeSearch(query.search);
    const requestedPage = normalizePage(query.page);
    const visible = { status: { $ne: 'deleted' } };

    const masterIds = activeSection === 'subaccounts' && search
        ? await findMatchingMasterIds({ User, ClientCompany }, search)
        : [];
    const sectionFilter = buildSectionFilter(activeSection, search, masterIds);

    const countQueries = [
        User.countDocuments({ ...visible, role: { $ne: 'agent' } }),
        ClientCompany.countDocuments(visible),
        User.countDocuments({ ...visible, role: 'agent' }),
        SubAccount.countDocuments(visible)
    ];
    const model = modelForSection({ User, ClientCompany, SubAccount }, activeSection);
    const [usersCount, companiesCount, agentsCount, subaccountsCount, filteredCount] = await Promise.all([
        ...countQueries,
        model.countDocuments(sectionFilter)
    ]);

    const totalPages = Math.max(1, Math.ceil(filteredCount / DEFAULT_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    let records = await model.find(sectionFilter)
        .select(fieldsForSection(activeSection))
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * DEFAULT_PAGE_SIZE)
        .limit(DEFAULT_PAGE_SIZE)
        .lean();

    if (activeSection === 'subaccounts') {
        records = await attachMasterNames({ User, ClientCompany }, records);
    }

    const result = {
        users: [],
        companies: [],
        agents: [],
        subAccounts: [],
        activeSection,
        search,
        directoryCounts: {
            users: usersCount,
            companies: companiesCount,
            agents: agentsCount,
            subaccounts: subaccountsCount,
            total: usersCount + companiesCount + agentsCount + subaccountsCount
        },
        pagination: {
            page,
            pageSize: DEFAULT_PAGE_SIZE,
            totalItems: filteredCount,
            totalPages,
            startItem: filteredCount ? ((page - 1) * DEFAULT_PAGE_SIZE) + 1 : 0,
            endItem: Math.min(page * DEFAULT_PAGE_SIZE, filteredCount)
        }
    };

    if (activeSection === 'subaccounts') result.subAccounts = records;
    else result[activeSection] = records;

    return result;
};

module.exports = {
    DIRECTORY_SECTIONS,
    DEFAULT_PAGE_SIZE,
    normalizeSection,
    normalizeSearch,
    normalizePage,
    buildSectionFilter,
    loadAdminAccountDirectory
};
