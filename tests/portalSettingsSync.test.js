"use strict";
jest.mock("../services/auditService", () => ({
  logAction: jest.fn(async () => {}),
}));
jest.mock("../services/companyReportEmailMailer", () => ({
  configured: () => true,
  sendCode: jest.fn(async () => {}),
}));
jest.mock("../services/agentReportEmailMailer", () => ({
  configured: () => true,
  sendCode: jest.fn(async () => {}),
}));
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const express = require("express");
const Company = require("../models/ClientCompany");
const User = require("../models/User");
const Employee = require("../models/ClientEmployee");
const Push = require("../models/WebPushSubscription");
const Link = require("../models/TelegramAccountLink");
const { requireClientAuth } = require("../middlewares/clientPortalAuth");
const csrf = "settings-sync-test-csrf";
let mongo, app, owner, entity, tenant, base, adminPath, Email, Connection, kind;
const call = (role, method, url, body, token = csrf) => {
  const req = request(app)
    [method](url)
    .set("Accept", "application/json")
    .set("X-Test-Role", role);
  if (method !== "get") req.set("X-CSRF-Token", token).send(body);
  return req;
};
const admin = (body, token) => call("master", "post", adminPath, body, token);
const snapshot = async () => (await call("master", "get", adminPath)).body.data;
const portal = (path, body) => call("owner", "post", base + path, body);
beforeAll(async () => {
  process.env.SESSION_SECRET =
    "settings-test-session-secret-long-enough-123456";
  process.env.TENANT_MODE = "multi";
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.24" } });
  await mongoose.connect(mongo.getUri());
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    const role = req.get("X-Test-Role");
    req.session =
      role === "owner"
        ? {
            isClientLoggedIn: true,
            clientId: owner._id,
            accountType: kind === "company" ? "company" : "user",
            csrfToken: csrf,
            destroy: (cb) => cb(),
          }
        : {
            isLoggedIn: true,
            adminRole: role,
            adminId: new mongoose.Types.ObjectId(),
            adminName: "إدارة الاختبار",
            csrfToken: csrf,
          };
    req.tenant = {
      _id: req.get("X-Wrong-Tenant") ? new mongoose.Types.ObjectId() : tenant,
    };
    next();
  });
  app.use(require("../middlewares/csrfProtection"));
  app.use(require("../routes/adminPortalSettings"));
  app.use(require("../routes/merchantIntegrations"));
  app.use(require("../routes/portalNotificationDevice"));
  app.use(require("../routes/portalDisplayPreferences"));
  app.use(
    "/client",
    require("../routes/companyReportEmail"),
    require("../routes/companyTelegram"),
  );
  app.use(
    "/agent-portal",
    requireClientAuth,
    require("../routes/agentReportEmail"),
    require("../routes/agentTelegram"),
  );
  app.post(
    ["/client/settings/profile", "/agent-portal/settings/profile"],
    requireClientAuth,
    require("../controllers/portalWorkspace/settingsController")
      .postUpdateSettings,
  );
  app.use("/api/v1/merchant", require("../routes/merchantApi"));
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
describe.each(["company", "agent"])(
  "%s: shared administrative settings",
  (type) => {
    beforeEach(async () => {
      kind = type;
      tenant = new mongoose.Types.ObjectId();
      entity = await (kind === "company" ? Company : User).create({
        name: "اختبار المزامنة",
        tenantId: tenant,
        role: "agent",
        status: "active",
        webUsername: "sync-owner",
        webPassword: "sync-password-123",
      });
      owner =
        kind === "company"
          ? await Employee.create({
              name: "مالك تجريبي",
              companyId: entity._id,
              tenantId: tenant,
              role: "owner",
              webUsername: "sync-company-owner",
              webPassword: "sync-password-123",
            })
          : entity;
      base = kind === "company" ? "/client" : "/agent-portal";
      adminPath =
        "/admin/accounts/" + kind + "/" + entity._id + "/portal-settings";
      Email = require(
        kind === "company"
          ? "../models/CompanyReportEmail"
          : "../models/AgentReportEmail",
      );
      Connection = require(
        kind === "company"
          ? "../models/CompanyTelegramConnection"
          : "../models/AgentTelegramConnection",
      );
    });
    test("admin API gates appear in both account editor and details; changes enforce real API access", async () => {
      let data = await snapshot();
      expect(data.access.apiEnabled).toBe(false);
      expect(
        (
          await admin({
            section: "integrations",
            apiEnabled: true,
            webhooksEnabled: true,
            revision: data.access.revision,
          })
        ).status,
      ).toBe(200);
      expect(
        (await call("owner", "get", base + "/api/integrations")).body.data,
      ).toMatchObject({ apiEnabled: true, webhooksEnabled: true });
      const first = await portal("/api/integrations/rotate", {
        currentPassword: "sync-password-123",
      });
      expect(first.status).toBe(200);
      const second = await portal("/api/integrations/rotate", {
        currentPassword: "sync-password-123",
      });
      expect(second.status).toBe(200);
      const balance = (token) =>
        request(app)
          .get("/api/v1/merchant/balance")
          .set("x-api-key", token)
          .set("X-Test-Role", "owner");
      expect((await balance(first.body.data.token)).status).toBe(401);
      expect((await balance(second.body.data.token)).status).toBe(200);
      expect(
        (
          await admin({
            section: "integrations",
            apiEnabled: false,
            webhooksEnabled: false,
            revision: 0,
          })
        ).status,
      ).toBe(409);
      data = await snapshot();
      expect(JSON.stringify(data)).not.toContain(second.body.data.token);
      expect(
        (
          await admin({
            section: "integrations",
            apiEnabled: false,
            webhooksEnabled: false,
            revision: data.access.revision,
          })
        ).status,
      ).toBe(200);
      expect((await balance(second.body.data.token)).status).toBe(401);
    });
    test("email changes are shared, concurrent saves cannot overwrite, and unverified mail cannot be enabled", async () => {
      const email = await Email.create({
        [kind === "company" ? "companyId" : "agentId"]: entity._id,
        tenantId: tenant,
        actorId: owner._id,
        actorModel: kind === "company" ? "ClientEmployee" : "User",
        email: "verified@example.test",
        verifiedAt: new Date(),
        enabled: true,
      });
      const data = await snapshot();
      expect(data.emails[0].email).toBe(email.email);
      const results = await Promise.all([
        admin({
          section: "email",
          id: String(email._id),
          enabled: false,
          revision: 0,
        }),
        portal("/api/report-email/preferences", {
          enabled: false,
          revision: 0,
        }),
      ]);
      expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
      const status = (await call("owner", "get", base + "/api/report-email"))
        .body.data;
      expect(status).toMatchObject({ enabled: false, revision: 1 });
      expect(
        (
          await portal("/api/report-email/preferences", {
            enabled: true,
            revision: status.revision,
          })
        ).status,
      ).toBe(200);
      expect((await snapshot()).emails[0].enabled).toBe(true);
      await Email.updateOne({ _id: email._id }, { $unset: { verifiedAt: 1 } });
      expect(
        (
          await admin({
            section: "email",
            id: String(email._id),
            enabled: true,
            revision: 2,
          })
        ).status,
      ).toBe(422);
    });
    test("email verification uses the same version and cannot silently overwrite an administrative change", async () => {
      const start = await portal("/api/report-email/request-code", {
        email: "pending@example.test",
        revision: 0,
      });
      expect(start.status).toBe(200);
      const mailer = require(
        kind === "company"
          ? "../services/companyReportEmailMailer"
          : "../services/agentReportEmailMailer",
      );
      const code = mailer.sendCode.mock.calls.at(-1)[1];
      const data = await snapshot();
      expect(data.emails[0].pendingEmail).toBe("pending@example.test");
      expect(
        (
          await admin({
            section: "email",
            id: data.emails[0].id,
            enabled: false,
            revision: data.emails[0].revision,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await portal("/api/report-email/verify", {
            challengeId: start.body.data.challengeId,
            code,
            revision: start.body.data.revision,
          })
        ).status,
      ).toBe(409);
      expect((await snapshot()).emails[0].verified).toBe(false);
      const current = (await call("owner", "get", base + "/api/report-email"))
        .body.data;
      expect(
        (
          await portal("/api/report-email/verify", {
            challengeId: current.challengeId,
            code,
            revision: current.revision,
          })
        ).status,
      ).toBe(200);
      expect((await snapshot()).emails[0]).toMatchObject({
        verified: true,
        enabled: true,
      });
    });
    test("modern and legacy Telegram connections share names and enabled flags without overwrites", async () => {
      const modern = await Connection.create({
        [kind === "company" ? "companyId" : "agentId"]: entity._id,
        tenantId: tenant,
        name: "هاتف تجريبي",
        chatId: "7654321",
        linkedAt: new Date(),
        enabled: true,
        requestedById: owner._id,
        requestedByModel: kind === "company" ? "ClientEmployee" : "User",
      });
      await Link.create({
        ownerModel: kind === "company" ? "ClientCompany" : "User",
        ownerId: entity._id,
        tenantId: tenant,
        chatId: "987654321",
        linkedAt: new Date(),
        deliveryMode: "both",
        codeHash: "test-hash-" + kind,
        codeHint: "test-hint",
      });
      const data = await snapshot();
      expect(data.telegram).toHaveLength(2);
      expect(
        (
          await admin({
            section: "telegram",
            id: String(modern._id),
            enabled: false,
            revision: 0,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await portal("/api/telegram/connections/" + modern._id + "/name", {
            name: "اسم قديم",
            revision: 0,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await portal("/api/telegram/connections/" + modern._id + "/name", {
            name: "اسم جديد",
            revision: 1,
          })
        ).status,
      ).toBe(200);
      expect(
        (await snapshot()).telegram.find(
          (item) => item.id === String(modern._id),
        ),
      ).toMatchObject({ name: "اسم جديد", enabled: false, revision: 2 });
      expect(
        (
          await admin({
            section: "telegram",
            id: "legacy",
            enabled: false,
            revision: 0,
          })
        ).status,
      ).toBe(200);
      expect((await Link.findOne({ ownerId: entity._id })).deliveryMode).toBe(
        "whatsapp",
      );
      const portalStatus = (await call("owner", "get", base + "/api/telegram"))
        .body.data;
      expect(
        portalStatus.connections.find((item) => item.id === "legacy").enabled,
      ).toBe(false);
      expect(JSON.stringify(await snapshot())).not.toContain("test-hint");
    });
    test("browser subscriptions show the same state to admin and the device; stale device settings fail", async () => {
      const endpoint = "https://push.example.test/device";
      const push = await Push.create({
        endpoint,
        subscription: { endpoint, keys: { auth: "test", p256dh: "test" } },
        userId: String(owner._id),
        accountType: kind === "company" ? "company" : "user",
        active: true,
      });
      expect((await snapshot()).push).toHaveLength(1);
      expect(
        (
          await admin({
            section: "push",
            id: String(push._id),
            enabled: false,
            revision: 0,
          })
        ).status,
      ).toBe(200);
      expect(
        (await portal("/api/notification-device/status", { endpoint })).body
          .data,
      ).toMatchObject({ enabled: false, revision: 1 });
      expect(
        (
          await portal("/api/notification-device/preferences", {
            endpoint,
            enabled: true,
            revision: 0,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await portal("/api/notification-device/preferences", {
            endpoint,
            enabled: true,
            revision: 1,
          })
        ).status,
      ).toBe(200);
      expect((await snapshot()).push[0].enabled).toBe(true);
    });
    test("master, CSRF, tenant and resource ownership boundaries apply to every administrative edit", async () => {
      expect((await call("accountant", "get", adminPath)).status).toBe(403);
      expect(
        (
          await admin(
            {
              section: "integrations",
              apiEnabled: true,
              webhooksEnabled: false,
              revision: 0,
            },
            "bad-token",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .get(adminPath)
            .set("Accept", "application/json")
            .set("X-Test-Role", "master")
            .set("X-Wrong-Tenant", "1")
        ).status,
      ).toBe(404);
      expect(
        (
          await admin({
            section: "email",
            id: String(new mongoose.Types.ObjectId()),
            enabled: false,
            revision: 0,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await admin({
            section: "integrations",
            apiEnabled: true,
            webhooksEnabled: false,
          })
        ).status,
      ).toBe(409);
    });
    test("profile edits are shared and a stale admin or portal form cannot overwrite newer details", async () => {
      const profile = {
        contactName: "مسؤول تجريبي",
        city: "طرابلس",
        phone: "0912345678",
        email: "",
        address: "",
        registrationNumber: "",
        profileRevision: "0",
      };
      expect((await portal("/settings/profile", profile)).status).toBe(302);
      expect((await snapshot()).profile.businessProfile.city).toBe("طرابلس");
      const {
        updateEditableAccount,
      } = require("../services/adminAccountManagementService");
      const payload = {
        ...profile,
        name: entity.name,
        status: "active",
        tier: "1",
        creditLimit: "0",
        webUsername: entity.webUsername,
        city: "بنغازي",
      };
      await expect(
        updateEditableAccount({ type: kind, id: entity._id, payload }),
      ).rejects.toMatchObject({ code: "SETTINGS_CHANGED" });
      await updateEditableAccount({
        type: kind,
        id: entity._id,
        payload: { ...payload, profileRevision: "1" },
      });
      expect((await snapshot()).profile.businessProfile.city).toBe("بنغازي");
      const stale = await portal("/settings/profile", {
        ...profile,
        profileRevision: "1",
      });
      expect(stale.headers.location).toContain("settings_changed");
      expect((await snapshot()).profile.businessProfile.city).toBe("بنغازي");
    });
    test("display density is saved on the account, visible to admin, and rejects stale edits", async () => {
      const initial = await call(
        "owner",
        "get",
        base + "/api/display-preferences",
      );
      expect(initial.body.data).toEqual({
        density: "comfortable",
        revision: 0,
      });
      expect(
        (
          await portal("/api/display-preferences", {
            density: "compact",
            revision: 0,
          })
        ).status,
      ).toBe(200);
      expect(
        (await snapshot()).actors.find(
          (actor) => actor.id === String(owner._id),
        ).density,
      ).toBe("compact");
      expect(
        (
          await portal("/api/display-preferences", {
            density: "comfortable",
            revision: 0,
          })
        ).status,
      ).toBe(409);
      expect(
        (await call("owner", "get", base + "/api/display-preferences")).body
          .data,
      ).toEqual({ density: "compact", revision: 1 });
    });
    test("administrators can inspect inactive accounts and old records without revision fields", async () => {
      const email = await Email.create({
        [kind === "company" ? "companyId" : "agentId"]: entity._id,
        tenantId: tenant,
        actorId: owner._id,
        actorModel: kind === "company" ? "ClientEmployee" : "User",
        email: "legacy@example.test",
        verifiedAt: new Date(),
        enabled: true,
      });
      await Email.updateOne(
        { _id: email._id },
        { $unset: { settingsRevision: 1 } },
      );
      expect(
        (
          await admin({
            section: "email",
            id: String(email._id),
            enabled: false,
            revision: 0,
          })
        ).status,
      ).toBe(200);
      await (kind === "company" ? Company : User).updateOne(
        { _id: entity._id },
        { $set: { status: "inactive" } },
      );
      expect((await call("master", "get", adminPath)).status).toBe(200);
    });
  },
);
