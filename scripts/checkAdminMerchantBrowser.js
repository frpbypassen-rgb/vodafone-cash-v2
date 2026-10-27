"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const User = require("../models/User");
const Company = require("../models/ClientCompany");
const Employee = require("../models/ClientEmployee");
const AgentEmployee = require("../models/AgentEmployee");
const Transaction = require("../models/Transaction");
const { assertLocalSeedTarget } = require("./lib/productionDatabaseGuard");
const { loadPuppeteer } = require("../utils/puppeteerLoader");
async function main() {
  const target = assertLocalSeedTarget(process.env);
  if (target.databaseName !== "ahram_company_mobile_demo_v2")
    throw new Error("Requires the isolated preview database");
  const base = "http://127.0.0.1:4577";
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  let browser, admin;
  const created = [],
    prefix = "admin-layout-" + crypto.randomBytes(7).toString("hex");
  const remember = (Model, rows) => {
    created.push([Model, rows.map((row) => row._id)]);
    return rows;
  };
  try {
    const password = crypto.randomBytes(20).toString("hex");
    admin = await Admin.create({
      name: "اختبار تخطيط الإدارة",
      role: "master",
      status: "active",
      webUsername: prefix,
      webPassword: password,
      mustEnrollSecurity: false,
    });
    browser = await (
      await loadPuppeteer()
    ).launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    const page = await browser.newPage();
    const errors = [],
      writes = [],
      requests = [];
    page.on("request", (req) => {
      requests.push(req.url());
      if (
        req.method() === "POST" &&
        /\/(add-balance|void-balance-adjustment|delete|update-rate|update-limit|change-level)(\?|$)/.test(
          req.url(),
        )
      )
        writes.push(req.url());
    });
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    });
    await page.setRequestInterception(true);
    page.on("request", (req) =>
      req.url().startsWith(base) || req.url().startsWith("data:")
        ? req.continue()
        : req.abort(),
    );
    await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
    await page.type("#usernameInput", prefix);
    await page.type("#passwordInput", password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.$eval("#loginForm", (form) => form.requestSubmit()),
    ]);
    await page.goto(base + "/clients?section=companies", {
      waitUntil: "domcontentloaded",
    });
    page.on("pageerror", (error) =>
      errors.push({
        message: error.message,
        url: new URL(page.url()).pathname,
      }),
    );
    const click = async (selector) => {
      await page.$eval(selector, (el) =>
        el.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      await page.locator(selector).click();
    };
    const navigate = async (url) => {
      const res = await page.goto(base + url, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(res.status(), 200, url);
    };
    for (const kind of ["company", "agent"]) {
      const company = kind === "company",
        Model = company ? Company : User;
      const account = remember(Model, [
        await Model.create({
          name: prefix + "-" + kind + "-main",
          phone: company ? "0912345001" : "0912345002",
          role: "agent",
          status: "active",
          balance: company ? 23 : -7,
          webUsername: prefix + "-agency",
          webPassword: password,
        }),
      ])[0];
      const accountPath = (company ? "/company/" : "/user/") + account._id;
      const section = company ? "companies" : "agents";
      remember(
        Model,
        await Model.insertMany(
          Array.from({ length: 26 }, (_, i) => ({
            name: prefix + "-" + kind + "-row-" + i,
            role: "agent",
            status: i % 2 ? "inactive" : "active",
            balance: i - 12,
            ...(!company
              ? {
                  webUsername: prefix + "-extra-" + i,
                  webPassword: admin.webPassword,
                }
              : {}),
          })),
        ),
      );
      const Staff = company ? Employee : AgentEmployee;
      remember(
        Staff,
        await Staff.insertMany(
          Array.from({ length: 25 }, (_, i) => ({
            [company ? "companyId" : "agentId"]: account._id,
            name: prefix + "-staff-" + i,
            role: company && i === 0 ? "owner" : "employee",
            status: "active",
            webUsername: prefix + "-" + kind + "-staff-" + i,
            webPassword: admin.webPassword,
          })),
        ),
      );
      const txs = Array.from({ length: 25 }, (_, i) => ({
        _id: new mongoose.Types.ObjectId(),
        customId: prefix + "-TX-" + i,
        companyId: company ? account._id : null,
        userId: account.phone,
        amount: 10,
        costLYD: 2,
        status: "completed",
        notes: "اختبار العرض فقط",
        createdAt: new Date("2026-10-27T10:00:00Z"),
        updatedAt: new Date("2026-10-27T10:00:00Z"),
      }));
      txs.push({
        ...txs[0],
        _id: new mongoose.Types.ObjectId(),
        customId: prefix + "-PRIVATE",
        isSubAccountTx: true,
      });
      await Transaction.collection.insertMany(txs);
      remember(Transaction, txs);
      await navigate("/clients?section=" + section + "&search=" + prefix);
      assert.equal(
        await page.$$eval(
          "[data-merchant-list] tbody tr",
          (rows) => rows.length,
        ),
        24,
      );
      await click('.directory-pagination a[aria-label="الصفحة التالية"]');
      await page.waitForFunction(
        () =>
          new URL(location.href).searchParams.get("page") === "2" &&
          !document.querySelector(".directory-is-loading"),
      );
      assert.equal(
        await page.$$eval(
          "[data-merchant-list] tbody tr",
          (rows) => rows.length,
        ),
        3,
      );
      await click('.am-status-filters a[href*="status=active"]');
      await page.waitForFunction(
        () =>
          new URL(location.href).searchParams.get("status") === "active" &&
          !document.querySelector(".directory-is-loading"),
      );
      assert.equal(
        await page.$$eval(
          "[data-merchant-list] .am-status:not(.is-active)",
          (rows) => rows.length,
        ),
        0,
      );
      await page.$eval(
        "[data-directory-search] input[name=search]",
        (input, value) => {
          input.value = value;
        },
        account.name,
      );
      await click("[data-directory-search] button[type=submit]");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-merchant-list] tbody tr").length ===
            1 && !document.querySelector(".directory-is-loading"),
      );
      await click(".am-actions summary");
      assert.equal(await page.$eval(".am-actions", (el) => el.open), true);
      assert.ok(await page.$('.am-actions a[href$="/edit"]'));
      await click(".am-actions summary");
      fs.mkdirSync("outputs/admin-merchant-browser", { recursive: true });
      for (const width of [320, 390, 430, 1366]) {
        await page.setViewport({
          width,
          height: width > 700 ? 900 : 844,
          isMobile: width < 700,
          hasTouch: width < 700,
        });
        const fits = await page.$eval("[data-merchant-list]", (el) => {
          const rect = el.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth + 1 &&
            el.scrollWidth <= el.clientWidth + 1
          );
        });
        assert.equal(fits, true, "List must fit " + width);
        assert.equal(
          await page.$eval(".clients-header", (el) =>
            [...el.children]
              .filter((child) => getComputedStyle(child).display !== "none")
              .every((child) => {
                const r = child.getBoundingClientRect();
                return r.left >= 0 && r.right <= innerWidth + 1;
              }),
          ),
          true,
          "Directory header must fit " + width,
        );
      }
      await page.setViewport({width:1366,height:900,isMobile:false,hasTouch:false});
      await page.screenshot({path:"outputs/admin-merchant-browser/"+kind+"-list-desktop.png",fullPage:true});
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
      });
      await page.screenshot({
        path: "outputs/admin-merchant-browser/" + kind + "-list.png",
        fullPage: true,
      });
      await click(".bottom-nav-admin-mobile [data-sidebar-toggle]");
      await page.waitForFunction(() =>
        document.getElementById("sidebarMenu")?.classList.contains("active"),
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () =>
          !document.getElementById("sidebarMenu")?.classList.contains("active"),
      );
      await click(".am-cell-name a");
      await page.waitForSelector("[data-merchant-detail]");
      assert.equal(
        await page.$$eval(".am-table-ledger tbody tr", (rows) => rows.length),
        20,
      );
      assert.equal((await page.content()).includes(prefix + "-PRIVATE"), false);
      assert.ok(
        (await page.$eval(".am-pagination", (el) => el.textContent)).includes(
          "25",
        ),
      );
      assert.equal(await page.$("[data-admin-portal-settings]"), null);
      const select = async (tab) => {
        await page.setViewport({
          width: 390,
          height: 844,
          isMobile: true,
          hasTouch: true,
        });
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.select("[data-merchant-tab]", accountPath + "?tab=" + tab),
        ]);
        assert.equal(
          await page.$eval("[data-merchant-detail]", (el) => el.dataset.tab),
          tab,
        );
      };
      await select("finance");
      assert.equal(await page.$$eval('[data-merchant-detail] form[method="POST"]', forms => forms.every(form => form.querySelectorAll('input[name=_csrf]').length === 1 && Boolean(form.querySelector('input[name=_csrf]').value))), true);
      assert.ok(
        await page.$('form[action$="/add-balance"] input[name=_csrf][value]'),
      );
      assert.ok(await page.$('form[action$="/update-limit"]'));
      if (company) {
        await page.select("[data-company-detail-rate-mode]", "custom");
        assert.equal(
          await page.$$eval("[data-company-detail-rate-input]", (inputs) =>
            inputs.every((input) => !input.disabled),
          ),
          true,
        );
      }
      await select("staff");
      assert.equal(
        await page.$$eval(".am-table-staff tbody tr", (rows) => rows.length),
        20,
      );
      await select("settings");
      await page.waitForSelector("[data-aps-key]");
      assert.ok(await page.$("input[name=apiEnabled]"));
      await select("profile");
      assert.ok(await page.$('form[action$="/update-account-code"]'));
      assert.ok(await page.$('form[action$="/delete"]'));
      await select("audit");
      assert.equal(await page.$("[data-admin-portal-settings]"), null);
      await select("ledger");
      await page.$eval(
        ".am-ledger-filters input[name=q]",
        (input, value) => {
          input.value = value;
        },
        prefix + "-TX-24",
      );
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        click(".am-ledger-filters button[type=submit]"),
      ]);
      assert.equal(
        await page.$$eval(".am-table-ledger tbody tr", (rows) => rows.length),
        1,
      );
      for (const theme of ["light", "dark"])
        for (const width of [320, 390, 430, 1366]) {
          await page.setViewport({
            width,
            height: width > 700 ? 900 : 844,
            isMobile: width < 700,
            hasTouch: width < 700,
          });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          assert.equal(
            await page.$eval(
              ".am-section",
              (el) => el.scrollWidth <= el.clientWidth + 1,
            ),
            true,
            "Detail panel must fit " + width,
          );
        }
      await page.setViewport({width:1366,height:900,isMobile:false,hasTouch:false});
      await page.screenshot({path:"outputs/admin-merchant-browser/"+kind+"-detail-desktop.png",fullPage:true});
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
      });
      await page.screenshot({
        path: "outputs/admin-merchant-browser/" + kind + "-detail.png",
        fullPage: true,
      });
      await navigate(accountPath + "#merchant-integration-access");
      await page.waitForFunction(
        () =>
          document.querySelector("[data-merchant-detail]")?.dataset.tab ===
          "settings",
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(
      JSON.stringify({
        passed: true,
        realBackend: true,
        isolatedAccounts: true,
        directorySearchStatusAndPagination: true,
        detailsLedgerStaffSettingsProfileAudit: true,
        legacyLinks: true,
        noFinancialMutations: true,
        widths: [320, 390, 430, 1366],
        themes: ["light", "dark"],
      }),
    );
  } finally {
    if (browser) await browser.close();
    for (const [Model, ids] of created.reverse())
      await Model.collection.deleteMany({ _id: { $in: ids } });
    if (admin) await Admin.deleteOne({ _id: admin._id });
    await mongoose.disconnect();
  }
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
