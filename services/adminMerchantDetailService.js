"use strict";
const Transaction = require("../models/Transaction");
const Employee = require("../models/ClientEmployee");
const AgentEmployee = require("../models/AgentEmployee");
const AuditLog = require("../models/AuditLog");
const { adminAccountScope } = require("../utils/tenantScope");
const {
  buildAdminAccountHistoryQuery,
} = require("./adminAccountVisibilityService");
const {
  systemDateRange,
  systemDayStart,
  systemDateKey,
} = require("../config/systemTime");
const TABS = ["ledger", "finance", "staff", "settings", "profile", "audit"];
const PAGE_SIZE = 20;
const text = (value) =>
  typeof value === "string" ? value.trim().slice(0, 80) : "";
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeDetailQuery = (query = {}) => {
  const tab = TABS.includes(query.tab)
    ? query.tab
    : query.rateUpdated || query.rateError
      ? "finance"
      : query.ownerOtpSaved || query.ownerOtpError
        ? "profile"
        : "ledger";
  const filters = {
    tab,
    page: Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1)),
    q: text(query.q),
    from: text(query.from),
    to: text(query.to),
    status: [
      "deposit",
      "deduction",
      "completed",
      "processing",
      "pending",
      "rejected",
      "cancelled_by_admin",
    ].includes(query.status)
      ? query.status
      : "",
    error: "",
  };
  for (const value of [filters.from, filters.to]) {
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !systemDayStart(value) ||
        systemDateKey(systemDayStart(value)) !== value)
    )
      filters.error = "أدخل تاريخًا صحيحًا.";
  }
  if (filters.from && filters.to && filters.from > filters.to)
    filters.error = "تاريخ البداية يجب أن يسبق تاريخ النهاية.";
  return filters;
};
const buildLedgerFilter = ({ kind, account, tenant, filters }) => {
  const scope = buildAdminAccountHistoryQuery({ kind, account, tenant });
  if (filters.error) return { ...scope, _id: null };
  const dates = systemDateRange(filters.from, filters.to);
  if (dates) scope.createdAt = dates;
  if (filters.status) scope.status = filters.status;
  if (filters.q) {
    const term = new RegExp(escapeRegex(filters.q), "i");
    scope.$and = [
      {
        $or: ["customId", "notes", "vodafoneNumber", "accountName"].map(
          (field) => ({ [field]: term }),
        ),
      },
    ];
  }
  return scope;
};
const paged = async (Model, scope, fields, requestedPage) => {
  const count = await Model.countDocuments(scope);
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rows = await Model.find(scope)
    .select(fields)
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();
  return {
    rows,
    pagination: { page, totalPages, totalItems: count, pageSize: PAGE_SIZE },
  };
};
const loadMerchantTab = async (req, account, kind) => {
  const filters = normalizeDetailQuery(req.query);
  if (filters.tab === "audit" && req.session.adminRole !== "master")
    filters.tab = "profile";
  const result = {
    ...filters,
    filters,
    rows: [],
    pagination: { page: 1, totalPages: 1, totalItems: 0, pageSize: PAGE_SIZE },
  };
  const tenant = adminAccountScope(req);
  if (filters.tab === "ledger")
    Object.assign(
      result,
      await paged(
        Transaction,
        buildLedgerFilter({ kind, account, tenant, filters }),
        "customId amount costLYD status notes vodafoneNumber accountName createdAt updatedAt balanceAdjustment",
        filters.page,
      ),
    );
  if (filters.tab === "staff") {
    const scope = {
      ...tenant,
      [kind === "company" ? "companyId" : "agentId"]: account._id,
      status: { $ne: "deleted" },
    };
    if (filters.q) {
      const term = new RegExp(escapeRegex(filters.q), "i");
      scope.$or = ["name", "phone", "webUsername"].map((field) => ({
        [field]: term,
      }));
    }
    Object.assign(
      result,
      await paged(
        kind === "company" ? Employee : AgentEmployee,
        scope,
        "name phone webUsername role corporateRole status createdAt",
        filters.page,
      ),
    );
  }
  if (filters.tab === "audit" && req.session.adminRole === "master") {
    // Audit targets have historically been stored as either an ObjectId or a string.
    Object.assign(
      result,
      await paged(
        AuditLog,
        {
          ...tenant,
          targetId: { $in: [account._id, String(account._id)] },
          targetModel: kind === "company" ? "ClientCompany" : "User",
        },
        "action performedByName result createdAt metadata.section metadata.changedFields",
        filters.page,
      ),
    );
  }
  return result;
};
module.exports = {
  PAGE_SIZE,
  TABS,
  normalizeDetailQuery,
  buildLedgerFilter,
  loadMerchantTab,
};
