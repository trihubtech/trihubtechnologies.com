let ensureCompanyProfileSchemaPromise = null;

async function ensureCompanyProfileSchemaCompatibility(conn) {
  if (ensureCompanyProfileSchemaPromise) {
    return ensureCompanyProfileSchemaPromise;
  }

  ensureCompanyProfileSchemaPromise = (async () => {
    const [rows] = await conn.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'company_profiles'
         AND column_name IN ('company_id', 'country', 'state_code', 'state_name', 'upi_qr_image', 'authorized_signature', 'storage_used_bytes', 'bank_name', 'bank_account_number', 'bank_ifsc', 'bank_branch', 'terms_and_conditions')`
    );

    const existingColumns = new Set(rows.map((row) => String(row.COLUMN_NAME || "").toLowerCase()));

    if (!existingColumns.has("company_id")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN company_id INT UNSIGNED NULL AFTER user_id");
    }

    if (!existingColumns.has("country")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN country VARCHAR(120) NOT NULL DEFAULT 'India' AFTER gstin");
    }

    if (!existingColumns.has("state_code")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN state_code VARCHAR(2) NULL AFTER country");
    }

    if (!existingColumns.has("state_name")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN state_name VARCHAR(120) NULL AFTER state_code");
    }

    if (!existingColumns.has("upi_qr_image")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN upi_qr_image VARCHAR(500) NULL AFTER upi_name");
    }

    if (!existingColumns.has("authorized_signature")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN authorized_signature VARCHAR(500) NULL AFTER upi_qr_image");
    }

    if (!existingColumns.has("storage_used_bytes")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN storage_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER authorized_signature");
    }

    if (!existingColumns.has("bank_name")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN bank_name VARCHAR(180) NULL AFTER website");
    }

    if (!existingColumns.has("bank_account_number")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN bank_account_number VARCHAR(120) NULL AFTER bank_name");
    }

    if (!existingColumns.has("bank_ifsc")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN bank_ifsc VARCHAR(40) NULL AFTER bank_account_number");
    }

    if (!existingColumns.has("bank_branch")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN bank_branch VARCHAR(180) NULL AFTER bank_ifsc");
    }

    if (!existingColumns.has("terms_and_conditions")) {
      await conn.execute("ALTER TABLE company_profiles ADD COLUMN terms_and_conditions TEXT NULL AFTER storage_used_bytes");
    }
  })();

  try {
    await ensureCompanyProfileSchemaPromise;
  } catch (error) {
    ensureCompanyProfileSchemaPromise = null;
    throw error;
  }
}

module.exports = {
  ensureCompanyProfileSchemaCompatibility,
};
