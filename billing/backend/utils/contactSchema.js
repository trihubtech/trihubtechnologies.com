let ensureCustomersSchemaPromise = null;
let ensureVendorsSchemaPromise = null;

async function ensureContactSchemaCompatibility(conn, tableName, promiseKey) {
  if (promiseKey.current) {
    return promiseKey.current;
  }

  promiseKey.current = (async () => {
    const [rows] = await conn.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = ?
         AND column_name IN ('billing_address', 'shipping_address', 'country', 'state_name', 'state_code', 'balance')`,
      [tableName]
    );

    const existingColumns = new Set(rows.map((row) => String(row.COLUMN_NAME || "").toLowerCase()));

    if (!existingColumns.has("billing_address")) {
      await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN billing_address TEXT NULL`);
    }

    if (!existingColumns.has("shipping_address")) {
      await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN shipping_address TEXT NULL`);
    }

    if (!existingColumns.has("country")) {
      await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN country VARCHAR(120) NOT NULL DEFAULT 'India'`);
    }

    if (!existingColumns.has("state_name")) {
      await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN state_name VARCHAR(120) NULL`);
    }

    if (!existingColumns.has("state_code")) {
      await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN state_code VARCHAR(2) NULL`);
    }

    if (!existingColumns.has("balance")) {
      await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0.00`);
    }
  })();

  try {
    await promiseKey.current;
  } catch (error) {
    promiseKey.current = null;
    throw error;
  }
}

async function ensureCustomerSchemaCompatibility(conn) {
  return ensureContactSchemaCompatibility(conn, "customers", {
    get current() {
      return ensureCustomersSchemaPromise;
    },
    set current(value) {
      ensureCustomersSchemaPromise = value;
    },
  });
}

async function ensureVendorSchemaCompatibility(conn) {
  return ensureContactSchemaCompatibility(conn, "vendors", {
    get current() {
      return ensureVendorsSchemaPromise;
    },
    set current(value) {
      ensureVendorsSchemaPromise = value;
    },
  });
}

module.exports = {
  ensureCustomerSchemaCompatibility,
  ensureVendorSchemaCompatibility,
};
