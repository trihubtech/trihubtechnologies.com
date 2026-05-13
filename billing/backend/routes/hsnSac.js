const router = require("express").Router();
const { pool } = require("../config/db");
const { body, param, query, validationResult } = require("express-validator");
const { requirePermission } = require("../middleware/permissions");
const { STARTER_HSN_SAC_MASTER } = require("../utils/hsnSacCatalog");
const { ensureHsnSacSchemaCompatibility } = require("../utils/hsnSacSchema");

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ ok: false, error: "Validation failed", details: errors.mapped() });
  }
  return null;
}

function resolveEntryTypes(productType) {
  switch (productType) {
    case "JOB_WORK_PROCESSING_SERVICE":
      return ["JOBWORK"];
    case "SERVICES_OTHER":
      return ["SERVICE", "JOBWORK"];
    case "TRADING_GOODS":
    case "MANUFACTURED_GOODS":
    default:
      return ["GOODS"];
  }
}

function resolveRequestType(productType) {
  switch (productType) {
    case "JOB_WORK_PROCESSING_SERVICE":
      return "JOBWORK";
    case "SERVICES_OTHER":
      return "SERVICE";
    default:
      return "GOODS";
  }
}

function isMissingHsnMasterError(error) {
  return ["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(error?.code) || /hsn_sac_master|unknown column/i.test(String(error?.message || ""));
}

function isMissingHsnRequestError(error) {
  return ["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(error?.code) || /hsn_sac_requests|unknown column/i.test(String(error?.message || ""));
}

function getEntryTypePriority(entryType) {
  if (entryType === "JOBWORK") return 0;
  if (entryType === "SERVICE") return 1;
  return 2;
}

function searchFallbackMaster({ q, productType, limit }) {
  const normalizedQuery = String(q || "").trim().toLowerCase();
  const entryTypes = resolveEntryTypes(productType);

  return STARTER_HSN_SAC_MASTER.filter((row) => {
    if (!row.is_active || !entryTypes.includes(row.entry_type)) return false;
    if (!normalizedQuery) return true;

    return [row.code, row.description, row.keywords]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));
  })
    .sort((left, right) => {
      const leftCode = String(left.code || "");
      const rightCode = String(right.code || "");

      const leftPriority = leftCode === q ? 0 : leftCode.startsWith(q) ? 1 : 2;
      const rightPriority = rightCode === q ? 0 : rightCode.startsWith(q) ? 1 : 2;

      if (leftPriority !== rightPriority) return leftPriority - rightPriority;

      const leftTypePriority = getEntryTypePriority(left.entry_type);
      const rightTypePriority = getEntryTypePriority(right.entry_type);
      if (leftTypePriority !== rightTypePriority) return leftTypePriority - rightTypePriority;

      return String(left.description || "").localeCompare(String(right.description || ""));
    })
    .slice(0, limit)
    .map(({ keywords, is_active, ...row }) => row);
}

function lookupFallbackMaster(code, productType) {
  const entryTypes = resolveEntryTypes(productType);
  return (
    STARTER_HSN_SAC_MASTER.find(
      (row) => row.is_active && row.code === code && entryTypes.includes(row.entry_type)
    ) || null
  );
}

function mergeCatalogRows(primaryRows = [], fallbackRows = [], limit = 40) {
  const merged = [];
  const seenCodes = new Set();

  for (const row of [...primaryRows, ...fallbackRows]) {
    const code = String(row?.code || "").trim();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    merged.push(row);
    if (merged.length >= limit) break;
  }

  return merged;
}

function sortCatalogRows(rows = [], q = "") {
  const normalizedQuery = String(q || "").trim().toLowerCase();

  return [...rows].sort((left, right) => {
    const leftCode = String(left?.code || "").toLowerCase();
    const rightCode = String(right?.code || "").toLowerCase();

    const leftPriority = !normalizedQuery
      ? 0
      : leftCode === normalizedQuery
        ? 0
        : leftCode.startsWith(normalizedQuery)
          ? 1
          : 2;
    const rightPriority = !normalizedQuery
      ? 0
      : rightCode === normalizedQuery
        ? 0
        : rightCode.startsWith(normalizedQuery)
          ? 1
          : 2;

    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    const leftTypePriority = getEntryTypePriority(left?.entry_type);
    const rightTypePriority = getEntryTypePriority(right?.entry_type);
    if (leftTypePriority !== rightTypePriority) return leftTypePriority - rightTypePriority;

    return String(left?.description || "").localeCompare(String(right?.description || ""));
  });
}

router.get(
  "/search",
  requirePermission("can_list_products"),
  [
    query("q").optional({ checkFalsy: true }).trim(),
    query("product_type").optional({ checkFalsy: true }).trim(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  async (req, res, next) => {
    try {
      await ensureHsnSacSchemaCompatibility(pool);
      const q = String(req.query.q || "").trim();
      const productType = String(req.query.product_type || "TRADING_GOODS").trim();
      const limit = Number(req.query.limit || 40);
      const entryTypes = resolveEntryTypes(productType);
      const placeholders = entryTypes.map(() => "?").join(", ");

      const params = [...entryTypes];
      let where = `is_active = 1 AND entry_type IN (${placeholders})`;

      if (q) {
        where += " AND (code LIKE ? OR description LIKE ? OR keywords LIKE ?)";
        const like = `%${q}%`;
        params.push(like, like, like);
      }

      const [rows] = await pool.execute(
        `SELECT code, description, suggested_gst_rate, entry_type, chapter
         FROM hsn_sac_master
         WHERE ${where}
         ORDER BY
           CASE WHEN entry_type = 'JOBWORK' THEN 0 WHEN entry_type = 'SERVICE' THEN 1 ELSE 2 END,
           description
         LIMIT ${limit}`,
        params
      );

      const fallbackRows = searchFallbackMaster({ q, productType, limit });
      const mergedRows = mergeCatalogRows(sortCatalogRows(rows, q), fallbackRows, limit);

      return res.json({
        ok: true,
        data: mergedRows,
        source: "database+fallback",
      });
    } catch (error) {
      if (isMissingHsnMasterError(error)) {
        return res.json({
          ok: true,
          data: searchFallbackMaster({
            q: String(req.query.q || "").trim(),
            productType: String(req.query.product_type || "TRADING_GOODS").trim(),
            limit: Number(req.query.limit || 40),
          }),
          source: "fallback",
          message: "Showing the built-in starter HSN/SAC list until the latest database update is applied.",
        });
      }
      next(error);
    }
  }
);

router.get(
  "/lookup/:code",
  requirePermission("can_list_products"),
  [param("code").trim().notEmpty(), query("product_type").optional({ checkFalsy: true }).trim()],
  async (req, res, next) => {
    try {
      await ensureHsnSacSchemaCompatibility(pool);
      const code = String(req.params.code || "").trim().toUpperCase();
      const productType = String(req.query.product_type || "TRADING_GOODS").trim();
      const entryTypes = resolveEntryTypes(productType);
      const placeholders = entryTypes.map(() => "?").join(", ");

      const [[match]] = await pool.execute(
        `SELECT code, description, suggested_gst_rate, entry_type, chapter
         FROM hsn_sac_master
         WHERE code = ? AND is_active = 1 AND entry_type IN (${placeholders})
         LIMIT 1`,
        [code, ...entryTypes]
      );

      const fallbackMatch = lookupFallbackMaster(code, productType);
      return res.json({
        ok: true,
        verified: Boolean(match || fallbackMatch),
        data: match || fallbackMatch || null,
        source: match ? "database" : fallbackMatch ? "fallback" : "database",
      });
    } catch (error) {
      if (isMissingHsnMasterError(error)) {
        const fallbackMatch = lookupFallbackMaster(
          String(req.params.code || "").trim().toUpperCase(),
          String(req.query.product_type || "TRADING_GOODS").trim()
        );
        return res.json({ ok: true, verified: Boolean(fallbackMatch), data: fallbackMatch, source: "fallback" });
      }
      next(error);
    }
  }
);

router.post(
  "/requests",
  requirePermission("can_list_products"),
  [
    body("code").trim().notEmpty().withMessage("Code is required"),
    body("description").optional({ checkFalsy: true }).trim(),
    body("product_type").optional({ checkFalsy: true }).trim(),
  ],
  async (req, res, next) => {
    const err = validationErrors(req, res);
    if (err) return;

    try {
      await ensureHsnSacSchemaCompatibility(pool);
      const code = String(req.body.code || "").trim().toUpperCase();
      const description = req.body.description?.trim() || null;
      const productType = String(req.body.product_type || "TRADING_GOODS").trim();
      const requestType = resolveRequestType(productType);

      await pool.execute(
        `INSERT INTO hsn_sac_requests (user_id, code, description, requested_for_type)
         VALUES (?, ?, ?, ?)`,
        [req.user.id, code, description, requestType]
      );

      return res.status(201).json({
        ok: true,
        message: "Request submitted for review",
      });
    } catch (error) {
      if (isMissingHsnRequestError(error)) {
        return res.status(503).json({
          ok: false,
          error: "HSN/SAC request inbox is unavailable until the latest database update is applied.",
        });
      }
      next(error);
    }
  }
);

module.exports = router;
