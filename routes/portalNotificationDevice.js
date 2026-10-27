"use strict";
const router = require("express").Router();
const { requireClientAuth } = require("../middlewares/clientPortalAuth");
const { resolveWorkspace } = require("../services/businessPortalService");
const Push = require("../models/WebPushSubscription");
const {
  withRevision,
  conflict,
  revisionOf,
  actorLabel,
} = require("../utils/portalSettingsRevision");
const { fail } = require("../services/merchantIntegrationService");
const paths = (suffix) => [
  "/client/api/notification-device" + suffix,
  "/agent-portal/api/notification-device" + suffix,
];
const handle = (write) => async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.isCompany && !workspace.isAgent)
      throw fail("FORBIDDEN", "الإعداد غير متاح.");
    const endpoint = req.body?.endpoint || "";
    if (
      typeof endpoint !== "string" ||
      endpoint.length > 4096 ||
      (endpoint && !endpoint.startsWith("https://"))
    )
      throw fail("INVALID_DEVICE", "اشتراك غير صالح.", 400);
    const scope = {
      userId: String(workspace.actor._id),
      accountType: String(req.session.accountType),
      endpoint,
    };
    let row = endpoint ? await Push.findOne(scope).lean() : null;
    if (write) {
      withRevision({}, req.body.revision);
      if (typeof req.body.enabled !== "boolean")
        throw fail("INVALID_SETTINGS", "إعداد غير صالح.", 400);
      if (row) {
        row = await Push.findOneAndUpdate(
          withRevision(scope, req.body.revision),
          {
            $set: {
              active: req.body.enabled,
              settingsUpdatedBy: actorLabel(workspace),
            },
            $inc: { settingsRevision: 1 },
          },
          { returnDocument: "after" },
        ).lean();
        if (!row) throw conflict();
      } else {
        const subscription = req.body.subscription;
        if (
          !req.body.enabled ||
          !endpoint ||
          subscription?.endpoint !== endpoint ||
          typeof subscription.keys?.auth !== "string" ||
          typeof subscription.keys?.p256dh !== "string" ||
          subscription.keys.auth.length > 512 ||
          subscription.keys.p256dh.length > 512
        )
          throw fail(
            "DEVICE_NOT_REGISTERED",
            "فعّل اشتراك المتصفح أولاً.",
            422,
          );
        if (req.body.revision !== 0) throw conflict();
        try {
          row = await Push.create({
            ...scope,
            active: true,
            subscription: {
              endpoint,
              keys: {
                auth: subscription.keys.auth,
                p256dh: subscription.keys.p256dh,
              },
            },
            settingsRevision: 1,
            settingsUpdatedBy: actorLabel(workspace),
          });
        } catch (error) {
          if (error.code === 11000) throw conflict();
          throw error;
        }
      }
    }
    return res.json({
      success: true,
      data: {
        enabled: Boolean(row?.active),
        revision: revisionOf(row),
        configured: Boolean(
          process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY,
        ),
        publicKey: process.env.WEB_PUSH_PUBLIC_KEY || "",
      },
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({
        success: false,
        code: error.code || "DEVICE_SETTINGS_FAILED",
        error: error.statusCode ? error.message : "تعذر تحديث إعدادات المتصفح.",
      });
  }
};
router.post(paths("/status"), requireClientAuth, handle(false));
router.post(paths("/preferences"), requireClientAuth, handle(true));
module.exports = router;
