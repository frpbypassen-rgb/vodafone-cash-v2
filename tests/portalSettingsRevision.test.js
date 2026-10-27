"use strict";
const {
  withRevision,
  conflict,
  revisionOf,
} = require("../utils/portalSettingsRevision");

test("missing revisions require a refresh and malformed revisions cannot enter Mongo filters", () => {
  for (const revision of [undefined, null, "", -1, 1.5, {}, "0"]) {
    expect(() => withRevision({ _id: "account" }, revision)).toThrow();
  }
});
test("legacy records start at zero and compare-and-set retains the owner scope", () => {
  expect(revisionOf({})).toBe(0);
  expect(withRevision({ ownerId: "owner", tenantId: "tenant" }, 0)).toEqual({
    $and: [
      { ownerId: "owner", tenantId: "tenant" },
      {
        $or: [
          { settingsRevision: 0 },
          { settingsRevision: { $exists: false } },
        ],
      },
    ],
  });
  expect(
    withRevision({ _id: "owner" }, 2, "integrationAccess.revision"),
  ).toEqual({
    $and: [{ _id: "owner" }, { "integrationAccess.revision": 2 }],
  });
  expect(conflict()).toMatchObject({
    statusCode: 409,
    code: "SETTINGS_CHANGED",
  });
});
