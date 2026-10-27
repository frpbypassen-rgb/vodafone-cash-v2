"use strict";
const conflict = () =>
  Object.assign(
    new Error("تغيرت الإعدادات من نافذة أخرى. حدّث الحالة وراجعها قبل الحفظ."),
    { code: "SETTINGS_CHANGED", statusCode: 409 },
  );
const revisionOf = (row) =>
  Number.isSafeInteger(row?.settingsRevision) ? row.settingsRevision : 0;
const withRevision = (scope, revision, field = "settingsRevision") => {
  if (!Number.isSafeInteger(revision) || revision < 0) throw conflict();
  return {
    $and: [
      scope,
      revision === 0
        ? { $or: [{ [field]: 0 }, { [field]: { $exists: false } }] }
        : { [field]: revision },
    ],
  };
};
const revisionFields = {
  settingsRevision: { type: Number, default: 0 },
  settingsUpdatedBy: { type: String, maxlength: 160 },
};
const actorLabel = (workspace) =>
  (workspace.actor?.name || "صاحب الحساب").slice(0, 160);
module.exports = {
  withRevision,
  conflict,
  revisionOf,
  revisionFields,
  actorLabel,
};
