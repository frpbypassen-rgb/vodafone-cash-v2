"use strict";
const {
  normalizeDetailQuery,
  buildLedgerFilter,
} = require("../services/adminMerchantDetailService");
test("normalizes tabs and legacy deep links without loading unrelated sections", () => {
  expect(normalizeDetailQuery({ tab: "unknown" }).tab).toBe("ledger");
  expect(normalizeDetailQuery({ tab: "staff", page: "3" }).page).toBe(3);
  expect(normalizeDetailQuery({ rateUpdated: "1" }).tab).toBe("finance");
  expect(normalizeDetailQuery({ ownerOtpSaved: "1" }).tab).toBe("profile");
});
test("ledger filters retain account privacy and use Libya calendar boundaries", () => {
  const filters = normalizeDetailQuery({
    q: "A.*",
    from: "2026-10-01",
    to: "2026-10-02",
    status: "deposit",
  });
  const scoped = buildLedgerFilter({
    kind: "company",
    account: { _id: "company-a" },
    tenant: { tenantId: "tenant-a" },
    filters,
  });
  expect(scoped.companyId).toBe("company-a");
  expect(scoped.tenantId).toBe("tenant-a");
  expect(scoped.isSubAccountTx).toEqual({ $ne: true });
  expect(scoped.createdAt.$gte.toISOString()).toBe("2026-09-30T22:00:00.000Z");
  expect(scoped.$and[0].$or[0].customId.test("A.*")).toBe(true);
  expect(scoped.$and[0].$or[0].customId.test("A999")).toBe(false);
  expect(scoped.status).toBe("deposit");
  const invalid = normalizeDetailQuery({
    from: "2026-02-31",
    to: "2026-01-01",
  });
  expect(invalid.error).toBeTruthy();
});
