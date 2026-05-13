const { STARTER_HSN_SAC_MASTER } = require("./hsnSacCatalog");

let ensureHsnSacSchemaPromise = null;

async function tableExists(conn, tableName) {
  const [[row]] = await conn.execute(
    `SELECT COUNT(*) AS total
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [tableName]
  );
  return Number(row?.total || 0) > 0;
}

async function getColumns(conn, tableName) {
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [tableName]
  );

  return new Set(rows.map((row) => String(row.COLUMN_NAME || "").toLowerCase()));
}

async function ensureHsnSacMasterTable(conn) {
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS hsn_sac_master (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(20) NOT NULL,
      description VARCHAR(500) NOT NULL,
      suggested_gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      entry_type ENUM('GOODS','SERVICE','JOBWORK') NOT NULL DEFAULT 'GOODS',
      chapter VARCHAR(50) NULL,
      keywords TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hsn_sac_master_code (code),
      INDEX idx_hsn_sac_type (entry_type),
      INDEX idx_hsn_sac_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const columns = await getColumns(conn, "hsn_sac_master");

  if (!columns.has("code")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN code VARCHAR(20) NOT NULL AFTER id");
  }
  if (!columns.has("description")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN description VARCHAR(500) NOT NULL AFTER code");
  }
  if (!columns.has("suggested_gst_rate")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN suggested_gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER description");
  }
  if (!columns.has("entry_type")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN entry_type ENUM('GOODS','SERVICE','JOBWORK') NOT NULL DEFAULT 'GOODS' AFTER suggested_gst_rate");
  }
  if (!columns.has("chapter")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN chapter VARCHAR(50) NULL AFTER entry_type");
  }
  if (!columns.has("keywords")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN keywords TEXT NULL AFTER chapter");
  }
  if (!columns.has("is_active")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER keywords");
  }
  if (!columns.has("created_at")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER is_active");
  }
  if (!columns.has("updated_at")) {
    await conn.execute("ALTER TABLE hsn_sac_master ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at");
  }

  const valuesSql = STARTER_HSN_SAC_MASTER.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  const params = STARTER_HSN_SAC_MASTER.flatMap((row) => [
    row.code,
    row.description,
    row.suggested_gst_rate,
    row.entry_type,
    row.chapter,
    row.keywords,
    row.is_active,
  ]);

  await conn.execute(
    `INSERT INTO hsn_sac_master (code, description, suggested_gst_rate, entry_type, chapter, keywords, is_active)
     VALUES ${valuesSql}
     ON DUPLICATE KEY UPDATE
       description = VALUES(description),
       suggested_gst_rate = VALUES(suggested_gst_rate),
       entry_type = VALUES(entry_type),
       chapter = VALUES(chapter),
       keywords = VALUES(keywords),
       is_active = VALUES(is_active)`,
    params
  );
}

async function ensureHsnSacRequestsTable(conn) {
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS hsn_sac_requests (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      code VARCHAR(20) NOT NULL,
      description VARCHAR(500) NULL,
      requested_for_type ENUM('GOODS','SERVICE','JOBWORK') NOT NULL DEFAULT 'GOODS',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_hsn_sac_requests_user (user_id),
      INDEX idx_hsn_sac_requests_code (code),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const columns = await getColumns(conn, "hsn_sac_requests");

  if (!columns.has("user_id")) {
    await conn.execute("ALTER TABLE hsn_sac_requests ADD COLUMN user_id INT UNSIGNED NOT NULL AFTER id");
  }
  if (!columns.has("code")) {
    await conn.execute("ALTER TABLE hsn_sac_requests ADD COLUMN code VARCHAR(20) NOT NULL AFTER user_id");
  }
  if (!columns.has("description")) {
    await conn.execute("ALTER TABLE hsn_sac_requests ADD COLUMN description VARCHAR(500) NULL AFTER code");
  }
  if (!columns.has("requested_for_type")) {
    await conn.execute("ALTER TABLE hsn_sac_requests ADD COLUMN requested_for_type ENUM('GOODS','SERVICE','JOBWORK') NOT NULL DEFAULT 'GOODS' AFTER description");
  }
  if (!columns.has("created_at")) {
    await conn.execute("ALTER TABLE hsn_sac_requests ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER requested_for_type");
  }
}

async function ensureHsnSacSchemaCompatibility(conn) {
  if (ensureHsnSacSchemaPromise) {
    return ensureHsnSacSchemaPromise;
  }

  ensureHsnSacSchemaPromise = (async () => {
    const hasMasterTable = await tableExists(conn, "hsn_sac_master");
    const hasRequestTable = await tableExists(conn, "hsn_sac_requests");

    if (!hasMasterTable) {
      await ensureHsnSacMasterTable(conn);
    } else {
      await ensureHsnSacMasterTable(conn);
    }

    if (!hasRequestTable) {
      await ensureHsnSacRequestsTable(conn);
    } else {
      await ensureHsnSacRequestsTable(conn);
    }
  })();

  try {
    await ensureHsnSacSchemaPromise;
  } catch (error) {
    ensureHsnSacSchemaPromise = null;
    throw error;
  }
}

module.exports = {
  ensureHsnSacSchemaCompatibility,
};
