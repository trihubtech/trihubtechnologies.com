let ensureProductSchemaPromise = null;

const PRODUCT_TYPE_ENUM_SQL = `ENUM('TRADING_GOODS','MANUFACTURED_GOODS','JOB_WORK_PROCESSING_SERVICE','SERVICES_OTHER')`;

async function ensureProductSchemaCompatibility(conn) {
  if (ensureProductSchemaPromise) {
    return ensureProductSchemaPromise;
  }

  ensureProductSchemaPromise = (async () => {
    const [rows] = await conn.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'products'
         AND column_name IN ('barcode', 'hsn_sac_code', 'product_type')`
    );

    const existingColumns = new Set(rows.map((row) => String(row.COLUMN_NAME || "").toLowerCase()));

    if (!existingColumns.has("barcode")) {
      await conn.execute("ALTER TABLE products ADD COLUMN barcode VARCHAR(13) NULL UNIQUE AFTER code");
    }

    if (!existingColumns.has("hsn_sac_code")) {
      await conn.execute('ALTER TABLE products ADD COLUMN hsn_sac_code VARCHAR(20) NOT NULL DEFAULT "" AFTER name');
    }

    if (!existingColumns.has("product_type")) {
      await conn.execute(
        `ALTER TABLE products
         ADD COLUMN product_type ${PRODUCT_TYPE_ENUM_SQL}
         NOT NULL DEFAULT 'TRADING_GOODS' AFTER hsn_sac_code`
      );
    }
  })();

  try {
    await ensureProductSchemaPromise;
  } catch (error) {
    ensureProductSchemaPromise = null;
    throw error;
  }
}

module.exports = {
  ensureProductSchemaCompatibility,
};
