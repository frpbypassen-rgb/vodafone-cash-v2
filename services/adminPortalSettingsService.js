"use strict";
const mongoose = require("mongoose");
const Company = require("../models/ClientCompany");
const User = require("../models/User");
const Employee = require("../models/ClientEmployee");
const AgentEmployee = require("../models/AgentEmployee");
const Push = require("../models/WebPushSubscription");
const Endpoint = require("../models/MerchantWebhookEndpoint");
const integration = require("./merchantIntegrationService");
const {
  withRevision,
  revisionOf,
  conflict,
} = require("../utils/portalSettingsRevision");
const { adminAccountFindQuery } = require("./adminAccountVisibilityService");
const { tenantMode } = require("../middlewares/tenantResolver");

const loadContext = async (req) => {
  const company = req.params.type === "company";
  if (!company && req.params.type !== "agent")
    throw integration.fail("NOT_FOUND", "الحساب غير موجود.", 404);
  if (!mongoose.isObjectIdOrHexString(req.params.id))
    throw integration.fail("NOT_FOUND", "الحساب غير موجود.", 404);
  if (tenantMode() === "multi" && !req.tenant?._id)
    throw integration.fail("TENANT_REQUIRED", "تعذر تحديد المنشأة.");
  const Model = company ? Company : User;
  const scope = adminAccountFindQuery(req, {
    _id: req.params.id,
    ...(company ? {} : { role: "agent" }),
  });
  const entity = await Model.findOne(scope).lean();
  if (!entity) throw integration.fail("NOT_FOUND", "الحساب غير موجود.", 404);
  const workspace = {
    isCompany: company,
    isAgent: !company,
    entity,
    entityModel: company ? "ClientCompany" : "User",
    actor: {
      _id: req.session.adminId,
      name: req.session.adminName || "الإدارة",
    },
    permissions: { owner: true, canEditSettings: true },
  };
  return {
    company,
    Model,
    scope,
    entity,
    workspace,
    Email: require(
      company ? "../models/CompanyReportEmail" : "../models/AgentReportEmail",
    ),
    emailScope: {
      [company ? "companyId" : "agentId"]: entity._id,
      tenantId: entity.tenantId || null,
    },
    telegram: require(
      company
        ? "./companyTelegramSettingsService"
        : "./agentTelegramSettingsService",
    ),
  };
};
const actorIds = async (ctx) => {
  const rows = await (ctx.company ? Employee : AgentEmployee)
    .find({
      [ctx.company ? "companyId" : "agentId"]: ctx.entity._id,
      tenantId: ctx.entity.tenantId || null,
      status: { $ne: "deleted" },
    })
    .select("_id name role mfaEnabled preferences email otpDeliveryChannel")
    .lean();
  if (!ctx.company) rows.unshift(ctx.entity);
  return rows;
};
const pushScope = (ctx, actors) => ({
  userId: { $in: actors.map((actor) => String(actor._id)) },
  accountType: {
    $in: ctx.company
      ? ["company", "client_company"]
      : ["user", "agent", "agent_staff"],
  },
});
const snapshot = async (ctx) => {
  ctx.entity = await ctx.Model.findOne(ctx.scope)
    .select("+merchantApiKeyHash +apiToken")
    .lean();
  if (!ctx.entity)
    throw integration.fail("NOT_FOUND", "الحساب غير موجود.", 404);
  ctx.workspace.entity = ctx.entity;
  const actors = await actorIds(ctx);
  const [access, emails, telegram, push, webhooks] = await Promise.all([
    integration.describeStatus(ctx.entity),
    ctx.Email.find(ctx.emailScope)
      .select(
        "actorId actorModel email verifiedAt enabled pendingEmail challengeExpiresAt settingsRevision settingsUpdatedBy updatedAt lastSentAt lastDeliveryStatus",
      )
      .lean(),
    ctx.telegram.status(ctx.workspace),
    Push.find(pushScope(ctx, actors))
      .select(
        "_id userId accountType active settingsRevision settingsUpdatedBy updatedAt lastSuccessAt",
      )
      .lean(),
    Endpoint.find({
      ownerId: ctx.entity._id,
      ownerModel: ctx.workspace.entityModel,
      tenantId: ctx.entity.tenantId || null,
    })
      .select(
        "name url events enabled lastAttemptAt lastSuccessAt lastFailureAt",
      )
      .lean(),
  ]);
  const name = (id) =>
    actors.find((actor) => String(actor._id) === String(id))?.name ||
    "حساب سابق";
  return {
    access,
    profile: {
      name: ctx.entity.name,
      phone: ctx.entity.phone || "",
      businessProfile: ctx.entity.businessProfile || {},
    },
    actors: actors.map((actor) => ({
      id: String(actor._id),
      name: actor.name,
      role: actor.role,
      density: actor.preferences?.density || "comfortable",
      mfaEnabled: Boolean(actor.mfaEnabled),
      theme:
        actor.preferences?.companyTheme || actor.preferences?.clientTheme || "",
      email: actor.email || actor.businessProfile?.email || "",
      emailOtpEnabled: actor.otpDeliveryChannel === "email",
    })),
    emails: emails.map((row) => ({
      id: String(row._id),
      actor: name(row.actorId),
      email: row.email || "",
      verified: Boolean(row.verifiedAt),
      enabled: Boolean(row.enabled),
      pendingEmail:
        row.challengeExpiresAt > new Date() ? row.pendingEmail || "" : "",
      revision: revisionOf(row),
      updatedBy: row.settingsUpdatedBy || "",
      updatedAt: row.updatedAt,
      lastSentAt: row.lastSentAt || null,
    })),
    telegram: telegram.connections,
    push: push.map((row) => ({
      id: String(row._id),
      actor: name(row.userId),
      enabled: row.active,
      revision: revisionOf(row),
      updatedBy: row.settingsUpdatedBy || "",
      updatedAt: row.updatedAt,
      lastSuccessAt: row.lastSuccessAt,
    })),
    webhooks,
  };
};
const update = async (ctx, body) => {
  // Require a specific version even for a legacy document (revision zero).
  withRevision({}, body.revision);
  const updatedBy = ctx.workspace.actor.name;
  if (body.section === "integrations") {
    await integration.setAdminAccess(
      ctx.Model,
      ctx.scope,
      { apiEnabled: body.apiEnabled, webhooksEnabled: body.webhooksEnabled },
      body.revision,
      updatedBy,
    );
  } else if (body.section === "email" || body.section === "push") {
    if (
      typeof body.enabled !== "boolean" ||
      !mongoose.isObjectIdOrHexString(body.id)
    )
      throw integration.fail("INVALID_SETTINGS", "إعداد غير صالح.", 400);
    const email = body.section === "email";
    const Model = email ? ctx.Email : Push;
    const scope = {
      ...(email ? ctx.emailScope : pushScope(ctx, await actorIds(ctx))),
      _id: body.id,
    };
    const current = await Model.findOne(scope).lean();
    if (!current)
      throw integration.fail("NOT_FOUND", "الإعداد غير موجود.", 404);
    if (email && body.enabled && (!current.verifiedAt || !current.email))
      throw integration.fail(
        "EMAIL_NOT_VERIFIED",
        "يجب تأكيد البريد من البوابة قبل تفعيله.",
        422,
      );
    const changed = await Model.updateOne(withRevision(scope, body.revision), {
      $set: {
        [email ? "enabled" : "active"]: body.enabled,
        settingsUpdatedBy: updatedBy,
      },
      $inc: { settingsRevision: 1 },
    });
    if (!changed.matchedCount) throw conflict();
  } else if (body.section === "telegram") {
    if (body.action === "rename")
      await ctx.telegram.rename(
        ctx.workspace,
        body.id,
        body.name,
        body.revision,
      );
    else
      await ctx.telegram.setEnabled(
        ctx.workspace,
        body.enabled,
        body.id,
        body.revision,
      );
  } else throw integration.fail("INVALID_SETTINGS", "إعداد غير صالح.", 400);
};
module.exports = { loadContext, snapshot, update };
