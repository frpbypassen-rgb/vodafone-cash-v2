"use strict";
const router = require("express").Router();
const { requireClientAuth } = require("../middlewares/clientPortalAuth");
const { resolveWorkspace } = require("../services/businessPortalService");
const { withRevision, conflict } = require("../utils/portalSettingsRevision");
const models = {
  User: require("../models/User"),
  AgentEmployee: require("../models/AgentEmployee"),
  ClientEmployee: require("../models/ClientEmployee"),
};
const paths = [
  "/client/api/display-preferences",
  "/agent-portal/api/display-preferences",
];
const handle = (write) => async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const workspace = await resolveWorkspace(req),
      Model = models[workspace.actorModel];
    let actor = workspace.actor;
    if (!Model)
      return res
        .status(403)
        .json({ success: false, error: "الإعداد غير متاح." });
    if (write) {
      if (!["comfortable", "compact"].includes(req.body.density))
        return res
          .status(400)
          .json({ success: false, error: "كثافة العرض غير صالحة." });
      actor = await Model.findOneAndUpdate(
        withRevision(
          {
            _id: actor._id,
            tenantId: workspace.entity.tenantId || null,
            status: "active",
          },
          req.body.revision,
          "displayRevision",
        ),
        {
          $set: { "preferences.density": req.body.density },
          $inc: { displayRevision: 1 },
        },
        { returnDocument: "after" },
      )
        .select("preferences displayRevision")
        .lean();
      if (!actor) throw conflict();
    }
    return res.json({
      success: true,
      data: {
        density: actor.preferences?.density || "comfortable",
        revision: actor.displayRevision || 0,
      },
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({
        success: false,
        error: error.statusCode ? error.message : "تعذر حفظ تفضيل العرض.",
      });
  }
};
router.get(paths, requireClientAuth, handle(false));
router.post(paths, requireClientAuth, handle(true));
module.exports = router;
