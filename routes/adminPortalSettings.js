"use strict";
const router = require("express").Router();
const { requireAuth, requireMaster } = require("../middlewares/auth");
const service = require("../services/adminPortalSettingsService");
const { logAction } = require("../services/auditService");
const path = "/admin/accounts/:type/:id/portal-settings";
const handle = (write) => async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const ctx = await service.loadContext(req);
    if (write) {
      await service.update(ctx, req.body || {});
      await logAction({
        action: "ADMIN_PORTAL_SETTINGS_CHANGED",
        req,
        performedById: req.session.adminId,
        performedByModel: "Admin",
        performedByName: ctx.workspace.actor.name,
        targetId: ctx.entity._id,
        targetModel: ctx.workspace.entityModel,
        result: "ناجح",
        metadata: {
          section: req.body.section,
          resourceId: typeof req.body.id === 'string' ? req.body.id : null,
          revision: req.body.revision,
        },
      });
    }
    return res.json({ success: true, data: await service.snapshot(ctx) });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({
        success: false,
        code: error.code || "SETTINGS_FAILED",
        error: error.statusCode
          ? error.message
          : "تعذر تحميل أو حفظ إعدادات الحساب.",
      });
  }
};
router.get(path, requireAuth, requireMaster, handle(false));
router.post(path, requireAuth, requireMaster, handle(true));
module.exports = router;
