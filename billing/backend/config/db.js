const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",

  // TiDB usually uses 4000
  port: parseInt(process.env.DB_PORT || "4000", 10),

  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "trihub",

  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,

  dateStrings: true,
  timezone: "+05:30",
  charset: "utf8mb4",
  decimalNumbers: true,

  // IMPORTANT
  ssl: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: false,
  },
});

pool.getConnection()
  .then((conn) => {
    console.log("✅ MySQL connected");
    conn.release();
  })
  .catch((err) => {
    console.error("❌ MySQL connection failed:", err.message);
    process.exit(1);
  });

async function getNextCode(conn, entity) {
  await conn.execute(
    "SELECT value FROM counters WHERE id = ? FOR UPDATE",
    [entity]
  );

  await conn.execute(
    "UPDATE counters SET value = value + 1 WHERE id = ?",
    [entity]
  );

  const [[row]] = await conn.execute(
    "SELECT prefix, value FROM counters WHERE id = ?",
    [entity]
  );

  return `${row.prefix}-${String(row.value).padStart(4, "0")}`;
}

async function getCurrentStock(conn, productId, userId) {
  const [[row]] = await conn.execute(
    `SELECT new_qty FROM inventory
     WHERE product_id = ? AND user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [productId, userId]
  );

  return row ? Number(row.new_qty) : 0;
}

async function adjustStock(conn, params) {
  const currentQty = await getCurrentStock(
    conn,
    params.productId,
    params.userId
  );

  const newQty = currentQty + params.adjustment;

  if (newQty < 0) {
    const [[prod]] = await conn.execute(
      "SELECT name FROM products WHERE id = ? AND user_id = ?",
      [params.productId, params.userId]
    );

    const name = prod?.name ?? `Product #${params.productId}`;

    throw Object.assign(
      new Error(
        `Insufficient stock for "${name}". Available: ${currentQty}, Required: ${Math.abs(params.adjustment)}`
      ),
      {
        status: 422,
        code: "INSUFFICIENT_STOCK",
      }
    );
  }

  await conn.execute(
    `INSERT INTO inventory
      (user_id, code, date, reason, product_id, current_qty, adjustment, new_qty, type, ref_id, ref_code)
     VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.userId,
      params.inventoryCode,
      params.reason,
      params.productId,
      currentQty,
      params.adjustment,
      newQty,
      params.type,
      params.refId ?? null,
      params.refCode ?? null,
    ]
  );
}

async function logActivity(
  conn,
  { userId, type, entityId, entityCode, description, metadata }
) {
  await conn.execute(
    `INSERT INTO activities (user_id, type, entity_id, entity_code, description, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      type,
      entityId ?? null,
      entityCode ?? null,
      description,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

module.exports = {
  pool,
  getNextCode,
  getCurrentStock,
  adjustStock,
  logActivity,
};