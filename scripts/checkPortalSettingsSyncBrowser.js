"use strict";
// Uses fresh, temporary accounts only. Never sends mail, Telegram messages or web pushes.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const User = require("../models/User");
const Company = require("../models/ClientCompany");
const Employee = require("../models/ClientEmployee");
const { assertLocalSeedTarget } = require("./lib/productionDatabaseGuard");
const { loadPuppeteer } = require("../utils/puppeteerLoader");
async function main() {
  const target = assertLocalSeedTarget(process.env);
  if (target.databaseName !== "ahram_company_mobile_demo_v2")
    throw new Error("Requires isolated preview database");
  const base = "http://127.0.0.1:4577";
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  let browser, admin;
  const created = [];
  try {
    const password = crypto.randomBytes(20).toString("hex");
    const prefix = "settings-ui-" + crypto.randomBytes(8).toString("hex");
    admin = await Admin.create({
      name: "إدارة اختبار المزامنة",
      role: "master",
      status: "active",
      webUsername: prefix + "-admin",
      webPassword: password,
      mustEnrollSecurity: false,
    });
    browser = await (
      await loadPuppeteer()
    ).launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    const newPage = async () => {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
      });
      await page.setRequestInterception(true);
      page.on("request", (request) =>
        request.url().startsWith(base) || request.url().startsWith("data:")
          ? request.continue()
          : request.abort(),
      );
      return page;
    };
    const login = async (page, username) => {
      await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
      await page.type("#usernameInput", username);
      await page.type("#passwordInput", password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.$eval("#loginForm", (form) => form.requestSubmit()),
      ]);
    };
    const click = async (page, selector) => {
      await page.$eval(selector, (el) =>
        el.scrollIntoView({ block: "center" }),
      );
      await page.locator(selector).click();
    };
    const adminPage = await newPage();
    await login(adminPage, admin.webUsername);
    const errors = [];
    adminPage.on("pageerror", (error) => errors.push(error.message));
    for (const kind of ["company", "agent"]) {
      const isCompany = kind === "company";
      const Model = isCompany ? Company : User;
      const entity = await Model.create({
        name: "اختبار عرض الإعدادات",
        status: "active",
        role: "agent",
        webUsername: prefix + "-agent",
        webPassword: password,
      });
      created.push([Model, entity._id]);
      const owner = isCompany
        ? await Employee.create({
            companyId: entity._id,
            name: "مالك اختبار العرض",
            role: "owner",
            webUsername: prefix + "-owner",
            webPassword: password,
          })
        : entity;
      if (isCompany) created.push([Employee, owner._id]);
      const Email = require(
        isCompany
          ? "../models/CompanyReportEmail"
          : "../models/AgentReportEmail",
      );
      const Connection = require(
        isCompany
          ? "../models/CompanyTelegramConnection"
          : "../models/AgentTelegramConnection",
      );
      const email = await Email.create({
        [isCompany ? "companyId" : "agentId"]: entity._id,
        actorId: owner._id,
        actorModel: isCompany ? "ClientEmployee" : "User",
        email: "ui-only@example.test",
        verifiedAt: new Date(),
        enabled: true,
      });
      created.push([Email, email._id]);
      const connection = await Connection.create({
        [isCompany ? "companyId" : "agentId"]: entity._id,
        name: "هاتف تجريبي",
        chatId: "87654321",
        linkedAt: new Date(),
        enabled: true,
        requestedById: owner._id,
        requestedByModel: isCompany ? "ClientEmployee" : "User",
      });
      created.push([Connection, connection._id]);
      const editorUrl =
        base + "/admin/accounts/" + kind + "/" + entity._id + "/edit";
      await adminPage.goto(editorUrl, { waitUntil: "domcontentloaded" });
      await adminPage.waitForSelector('[data-aps-toggle="email"]');
      assert.equal(
        await adminPage.$eval(
          "[data-aps-integrations] input[name=apiEnabled]",
          (el) => el.checked,
        ),
        false,
      );
      const portalPage = await newPage();
      portalPage.on("pageerror", (error) => errors.push(error.message));
      await login(portalPage, owner.webUsername);
      const portalBase = isCompany ? "/client" : "/agent-portal";
      await portalPage.goto(base + portalBase + "/settings#integrations", {
        waitUntil: "domcontentloaded",
      });
      for (const id of [
        "companyWelcomeDialog",
        "companyLowBalanceDialog",
        "companyMessageDialog",
      ])
        await portalPage.evaluate(
          (id) => document.getElementById(id)?.close(),
          id,
        );
      await portalPage.waitForFunction(() =>
        document
          .querySelector("[data-mi-api-state]")
          ?.textContent.includes("غير مفعل"),
      );
      await click(adminPage, "[data-aps-integrations] input[name=apiEnabled]");
      await click(adminPage, "[data-aps-integrations] button[type=submit]");
      await adminPage.waitForFunction(() =>
        document
          .querySelector("[data-aps-result]")
          ?.textContent.includes("تم الحفظ"),
      );
      await click(portalPage, "[data-mi-refresh]");
      await portalPage.waitForFunction(
        () => document.querySelector("[data-mi-key-form]")?.hidden === false,
      );
      // An administrative email edit must arrive through normal focus refresh, without re-login.
      await click(adminPage, '[data-aps-toggle="email"]');
      await adminPage.waitForFunction(
        () =>
          document.querySelector('[data-aps-toggle="email"]')?.checked ===
          false,
      );
      await portalPage.goto(base + portalBase + "/settings#notifications", {
        waitUntil: "domcontentloaded",
      });
      await portalPage.waitForSelector("[data-report-email-toggle]");
      await portalPage.waitForFunction(() =>
        document
          .querySelector("[data-report-email-summary]")
          ?.textContent.includes("الإرسال متوقف"),
      );
      await click(portalPage, "[data-report-email-toggle]");
      await portalPage.waitForFunction(
        () =>
          document.querySelector("[data-report-email-toggle]")?.checked ===
          true,
      );
      await click(adminPage, "[data-aps-refresh]");
      await adminPage.waitForFunction(
        () =>
          document.querySelector('[data-aps-toggle="email"]')?.checked === true,
      );
      await click(adminPage, '[data-aps-toggle="telegram"]');
      await adminPage.waitForFunction(
        () =>
          document.querySelector('[data-aps-toggle="telegram"]')?.checked ===
          false,
      );
      await portalPage.evaluate(() => window.dispatchEvent(new Event("focus")));
      await portalPage.waitForFunction(
        () =>
          document.querySelector('[data-telegram-action="toggle"]')?.checked ===
          false,
      );
      if (!isCompany) {
        await portalPage.goto(base + portalBase + '/settings#preferences', { waitUntil: 'domcontentloaded' });
        await portalPage.waitForSelector('[data-server-density]');
        await portalPage.select('[data-server-density]', 'compact');
        await portalPage.waitForFunction(() => document.documentElement.dataset.density === 'compact');
        await portalPage.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(await portalPage.evaluate(() => document.documentElement.dataset.density), 'compact');
      }
      for (const theme of ["light", "dark"])
        for (const width of [320, 390, 430]) {
          await adminPage.setViewport({
            width,
            height: 844,
            isMobile: true,
            hasTouch: true,
          });
          await adminPage.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          const overflow = await adminPage.$eval(
            "[data-admin-portal-settings]",
            (el) => el.scrollWidth > el.clientWidth + 1,
          );
          assert.equal(
            overflow,
            false,
            "Settings panel must fit the mobile viewport",
          );
        }
      fs.mkdirSync("outputs/settings-sync-browser", { recursive: true });
      await adminPage.screenshot({
        path: "outputs/settings-sync-browser/" + kind + "-admin.png",
        fullPage: true,
      });
      await adminPage.goto(
        base + (isCompany ? "/company/" : "/user/") + entity._id + "?tab=settings",
        { waitUntil: "domcontentloaded" },
      );
      await adminPage.waitForSelector('[data-aps-toggle="email"]');
      assert.equal(
        await adminPage.$eval(
          "[data-aps-integrations] input[name=apiEnabled]",
          (el) => el.checked,
        ),
        true,
      );
      await portalPage.browserContext().close();
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        realBackend: true,
        isolatedAccounts: true,
        portals: ["company", "agent"],
        adminEditorAndDetails: true,
        apiGate: true,
        emailBidirectional: true,
        telegramRefresh: true,
        mobileWidths: [320, 390, 430],
        themes: ["light", "dark"],
      }),
    );
  } finally {
    if (browser) await browser.close();
    for (const [Model, id] of created.reverse())
      await Model.deleteOne({ _id: id });
    if (admin) await Admin.deleteOne({ _id: admin._id });
    await mongoose.disconnect();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
