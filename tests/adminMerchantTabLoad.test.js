"use strict";
const query = () => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue([]),
});
jest.mock("../models/Transaction", () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../models/ClientEmployee", () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../models/AgentEmployee", () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../models/AuditLog", () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
const Transaction = require("../models/Transaction");
const Employee = require("../models/ClientEmployee");
const AgentEmployee = require("../models/AgentEmployee");
const AuditLog = require("../models/AuditLog");
const { loadMerchantTab } = require("../services/adminMerchantDetailService");
beforeEach(() => {
  jest.clearAllMocks();
  process.env.TENANT_MODE = "multi";
  for (const Model of [Transaction, Employee, AgentEmployee, AuditLog]) {
    Model.countDocuments.mockResolvedValue(41);
    Model.find.mockImplementation(query);
  }
});
const req = (tab) => ({
  query: { tab, page: "999" },
  tenantId: "tenant-a",
  session: { adminRole: "master" },
});
test("sections load only their own bounded data and clamp pagination", async () => {
  const result = await loadMerchantTab(
    req("ledger"),
    { _id: "company-a" },
    "company",
  );
  expect(result.pagination).toMatchObject({
    page: 3,
    pageSize: 20,
    totalPages: 3,
  });
  const chain = Transaction.find.mock.results[0].value;
  expect(chain.skip).toHaveBeenCalledWith(40);
  expect(chain.limit).toHaveBeenCalledWith(20);
  expect(Employee.find).not.toHaveBeenCalled();
  expect(AuditLog.find).not.toHaveBeenCalled();
  expect(Transaction.find).toHaveBeenCalledWith(
    expect.objectContaining({
      companyId: "company-a",
      tenantId: "tenant-a",
      isSubAccountTx: { $ne: true },
    }),
  );
});
test.each(["settings", "finance", "profile"])(
  "%s does not fetch ledger, staff or audit records",
  async (tab) => {
    await loadMerchantTab(req(tab), { _id: "company-a" }, "company");
    for (const Model of [Transaction, Employee, AgentEmployee, AuditLog])
      expect(Model.find).not.toHaveBeenCalled();
  },
);
test("staff are scoped to the selected company or agency; audit never exposes raw snapshots", async () => {
  await loadMerchantTab(req("staff"), { _id: "agency-a" }, "agent");
  expect(AgentEmployee.find).toHaveBeenCalledWith({
    tenantId: "tenant-a",
    agentId: "agency-a",
    status: { $ne: "deleted" },
  });
  await loadMerchantTab(req("audit"), { _id: "agency-a" }, "agent");
  expect(
    AuditLog.find.mock.results[0].value.select.mock.calls[0][0],
  ).not.toMatch(/oldData|newData|ipAddress/);
  jest.clearAllMocks();
  const restricted = { ...req("audit"), session: { adminRole: "admin" } };
  expect(
    (await loadMerchantTab(restricted, { _id: "agency-a" }, "agent")).tab,
  ).toBe("profile");
  expect(AuditLog.find).not.toHaveBeenCalled();
});
