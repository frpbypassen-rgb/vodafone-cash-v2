'use strict';

const DIRECTORY_SECTIONS = Object.freeze(['users', 'companies', 'agents']);
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

const buildSectionFilter = (section, search = '') => {
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
        agents: ['name', 'phone', 'webUsername', 'accountCode', 'agentCode']
    };

    filter.$or = searchableFields[activeSection].map((field) => ({ [field]: term }));
    return filter;
};

const modelForSection = ({ User, ClientCompany }, section) => {
    if (section === 'companies') return ClientCompany;
    return User;
};

const fieldsForSection = (section) => {
    if (section === 'companies') return 'name phone tier balance accountCode token status createdAt';
    return 'name phone tier balance accountCode agentCode webUsername role status createdAt';
};

const loadAdminAccountDirectory = async ({ User, ClientCompany }, query = {}) => {
    const activeSection = normalizeSection(query.section);
    const search = normalizeSearch(query.search);
    const requestedPage = normalizePage(query.page);
    const visible = { status: { $ne: 'deleted' } };
    const sectionFilter = buildSectionFilter(activeSection, search);

    const model = modelForSection({ User, ClientCompany }, activeSection);
    const [usersCount, companiesCount, agentsCount, filteredCount] = await Promise.all([
        User.countDocuments({ ...visible, role: { $ne: 'agent' } }),
        ClientCompany.countDocuments(visible),
        User.countDocuments({ ...visible, role: 'agent' }),
        model.countDocuments(sectionFilter)
    ]);

    const totalPages = Math.max(1, Math.ceil(filteredCount / DEFAULT_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const records = await model.find(sectionFilter)
        .select(fieldsForSection(activeSection))
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * DEFAULT_PAGE_SIZE)
        .limit(DEFAULT_PAGE_SIZE)
        .lean();

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
            subaccounts: 0,
            total: usersCount + companiesCount + agentsCount
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

    result[activeSection] = records;
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
