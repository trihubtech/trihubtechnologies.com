-- ============================================================
-- TriHub Billing Software — MySQL Production Schema
-- Engine: InnoDB | Charset: utf8mb4
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;
SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- COUNTERS (atomic auto-code generation)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counters (
  id      VARCHAR(30)  NOT NULL,
  prefix  VARCHAR(10)  NOT NULL,
  value   INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO counters VALUES
  ('PRODUCT',   'PRD', 0),
  ('INVENTORY', 'STK', 0),
  ('CUSTOMER',  'CUS', 0),
  ('VENDOR',    'VEN', 0),
  ('INVOICE',   'SI',  0),
  ('BILL',      'PI',  0);

-- ------------------------------------------------------------
-- COMPANIES (tenants)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                 VARCHAR(200) NOT NULL,
  owner_user_id        INT UNSIGNED NULL,
  created_by_admin     TINYINT(1)   NOT NULL DEFAULT 0,
  subscription_plan    ENUM('TRIAL','MONTHLY','YEARLY') NOT NULL DEFAULT 'TRIAL',
  subscription_status  ENUM('ACTIVE','EXPIRED','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  trial_ends_at        DATETIME NULL,
  subscription_ends_at DATETIME NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_companies_owner_user (owner_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  email          VARCHAR(180)     NOT NULL UNIQUE,
  email_verified_at DATETIME      NULL,
  password_hash  VARCHAR(255)     NULL,
  auth_provider  ENUM('LOCAL','GOOGLE','BOTH') NOT NULL DEFAULT 'LOCAL',
  google_sub     VARCHAR(255)     NULL,
  name           VARCHAR(120)     NOT NULL,
  salutation     VARCHAR(10)      NOT NULL DEFAULT 'Mr.',
  dob            DATE             NULL,
  designation    VARCHAR(100)     NULL,
  mobile         VARCHAR(20)      NULL,
  profile_picture VARCHAR(500)    NULL,
  role           ENUM('OWNER','ADMIN','STAFF') NOT NULL DEFAULT 'OWNER',
  is_platform_admin TINYINT(1)    NOT NULL DEFAULT 0,
  -- trial & subscription fields removed (now managed in companies table)
  created_at     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users
  MODIFY COLUMN role ENUM('MASTER','ADMIN','NORMAL','OWNER','STAFF') NOT NULL DEFAULT 'MASTER';

SET @users_company_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'company_id'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN company_id INT UNSIGNED NULL AFTER email'
  )
);
PREPARE stmt_users_company_id FROM @users_company_id_sql;
EXECUTE stmt_users_company_id;
DEALLOCATE PREPARE stmt_users_company_id;

SET @users_status_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'status'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN status ENUM(''INVITED'',''ACTIVE'',''DISABLED'') NOT NULL DEFAULT ''ACTIVE'' AFTER role'
  )
);
PREPARE stmt_users_status FROM @users_status_sql;
EXECUTE stmt_users_status;
DEALLOCATE PREPARE stmt_users_status;

SET @users_invited_by_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'invited_by'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN invited_by INT UNSIGNED NULL AFTER status'
  )
);
PREPARE stmt_users_invited_by FROM @users_invited_by_sql;
EXECUTE stmt_users_invited_by;
DEALLOCATE PREPARE stmt_users_invited_by;

SET @users_invited_at_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'invited_at'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN invited_at DATETIME NULL AFTER invited_by'
  )
);
PREPARE stmt_users_invited_at FROM @users_invited_at_sql;
EXECUTE stmt_users_invited_at;
DEALLOCATE PREPARE stmt_users_invited_at;

SET @users_password_set_at_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'password_set_at'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN password_set_at DATETIME NULL AFTER invited_at'
  )
);
PREPARE stmt_users_password_set_at FROM @users_password_set_at_sql;
EXECUTE stmt_users_password_set_at;
DEALLOCATE PREPARE stmt_users_password_set_at;

SET @users_must_change_password_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'must_change_password'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER password_set_at'
  )
);
PREPARE stmt_users_must_change_password FROM @users_must_change_password_sql;
EXECUTE stmt_users_must_change_password;
DEALLOCATE PREPARE stmt_users_must_change_password;

SET @users_company_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND index_name = 'idx_users_company_id'
);
SET @users_company_index_sql := IF(
  @users_company_index_exists = 0,
  'ALTER TABLE users ADD INDEX idx_users_company_id (company_id)',
  'SELECT 1'
);
PREPARE stmt_users_company_index FROM @users_company_index_sql;
EXECUTE stmt_users_company_index;
DEALLOCATE PREPARE stmt_users_company_index;

SET @users_password_hash_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'password_hash'
    ),
    'ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL',
    'SELECT 1'
  )
);
PREPARE stmt_users_password_hash FROM @users_password_hash_sql;
EXECUTE stmt_users_password_hash;
DEALLOCATE PREPARE stmt_users_password_hash;

SET @users_email_verified_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'email_verified_at'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL AFTER email'
  )
);
PREPARE stmt_users_email_verified FROM @users_email_verified_sql;
EXECUTE stmt_users_email_verified;
DEALLOCATE PREPARE stmt_users_email_verified;

SET @users_auth_provider_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'auth_provider'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN auth_provider ENUM(''LOCAL'',''GOOGLE'',''BOTH'') NOT NULL DEFAULT ''LOCAL'' AFTER password_hash'
  )
);
PREPARE stmt_users_auth_provider FROM @users_auth_provider_sql;
EXECUTE stmt_users_auth_provider;
DEALLOCATE PREPARE stmt_users_auth_provider;

SET @users_google_sub_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'google_sub'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN google_sub VARCHAR(255) NULL AFTER auth_provider'
  )
);
PREPARE stmt_users_google_sub FROM @users_google_sub_sql;
EXECUTE stmt_users_google_sub;
DEALLOCATE PREPARE stmt_users_google_sub;

SET @users_google_sub_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND index_name = 'uq_users_google_sub'
);
SET @users_google_sub_index_sql := IF(
  @users_google_sub_index_exists = 0,
  'ALTER TABLE users ADD UNIQUE KEY uq_users_google_sub (google_sub)',
  'SELECT 1'
);
PREPARE stmt_users_google_sub_index FROM @users_google_sub_index_sql;
EXECUTE stmt_users_google_sub_index;
DEALLOCATE PREPARE stmt_users_google_sub_index;

SET @users_platform_admin_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'is_platform_admin'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN is_platform_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER role'
  )
);
PREPARE stmt_users_platform_admin FROM @users_platform_admin_sql;
EXECUTE stmt_users_platform_admin;
DEALLOCATE PREPARE stmt_users_platform_admin;

-- ------------------------------------------------------------
-- COMPANY PROFILE (one-to-one with user)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_profiles (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED  NOT NULL UNIQUE,
  name        VARCHAR(200)  NOT NULL,
  logo        VARCHAR(500)  NULL,
  address     TEXT          NULL,
  phone       VARCHAR(20)   NULL,
  email       VARCHAR(180)  NULL,
  gstin       VARCHAR(20)   NULL,
  country     VARCHAR(120)  NOT NULL DEFAULT 'India',
  state_code  VARCHAR(2)    NULL,
  state_name  VARCHAR(120)  NULL,
  pan         VARCHAR(15)   NULL,
  website     VARCHAR(300)  NULL,
  bank_name   VARCHAR(180)  NULL,
  bank_account_number VARCHAR(120) NULL,
  bank_ifsc   VARCHAR(40)   NULL,
  bank_branch VARCHAR(180)  NULL,
  upi_id      VARCHAR(100)  NULL,        -- used in QR code generation
  upi_name    VARCHAR(120)  NULL,        -- merchant display name for UPI
  upi_qr_image VARCHAR(500) NULL,
  authorized_signature VARCHAR(500) NULL,
  storage_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @company_profiles_company_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'company_id'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN company_id INT UNSIGNED NULL AFTER user_id'
  )
);
PREPARE stmt_company_profiles_company_id FROM @company_profiles_company_id_sql;
EXECUTE stmt_company_profiles_company_id;
DEALLOCATE PREPARE stmt_company_profiles_company_id;

SET @company_profiles_company_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'company_profiles'
    AND index_name = 'uq_company_profiles_company_id'
);
SET @company_profiles_company_index_sql := IF(
  @company_profiles_company_index_exists = 0,
  'ALTER TABLE company_profiles ADD UNIQUE KEY uq_company_profiles_company_id (company_id)',
  'SELECT 1'
);
PREPARE stmt_company_profiles_company_index FROM @company_profiles_company_index_sql;
EXECUTE stmt_company_profiles_company_index;
DEALLOCATE PREPARE stmt_company_profiles_company_index;

SET @company_profiles_upi_qr_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'upi_qr_image'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN upi_qr_image VARCHAR(500) NULL AFTER upi_name'
  )
);
PREPARE stmt_company_profiles_upi_qr FROM @company_profiles_upi_qr_sql;
EXECUTE stmt_company_profiles_upi_qr;
DEALLOCATE PREPARE stmt_company_profiles_upi_qr;

SET @company_profiles_country_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'country'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN country VARCHAR(120) NOT NULL DEFAULT "India" AFTER gstin'
  )
);
PREPARE stmt_company_profiles_country FROM @company_profiles_country_sql;
EXECUTE stmt_company_profiles_country;
DEALLOCATE PREPARE stmt_company_profiles_country;

SET @company_profiles_storage_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'storage_used_bytes'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN storage_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER upi_qr_image'
  )
);
PREPARE stmt_company_profiles_storage FROM @company_profiles_storage_sql;
EXECUTE stmt_company_profiles_storage;
DEALLOCATE PREPARE stmt_company_profiles_storage;

SET @company_profiles_signature_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'authorized_signature'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN authorized_signature VARCHAR(500) NULL AFTER upi_qr_image'
  )
);
PREPARE stmt_company_profiles_signature FROM @company_profiles_signature_sql;
EXECUTE stmt_company_profiles_signature;
DEALLOCATE PREPARE stmt_company_profiles_signature;

SET @company_profiles_bank_name_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'bank_name'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN bank_name VARCHAR(180) NULL AFTER website'
  )
);
PREPARE stmt_company_profiles_bank_name FROM @company_profiles_bank_name_sql;
EXECUTE stmt_company_profiles_bank_name;
DEALLOCATE PREPARE stmt_company_profiles_bank_name;

SET @company_profiles_bank_account_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'bank_account_number'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN bank_account_number VARCHAR(120) NULL AFTER bank_name'
  )
);
PREPARE stmt_company_profiles_bank_account FROM @company_profiles_bank_account_sql;
EXECUTE stmt_company_profiles_bank_account;
DEALLOCATE PREPARE stmt_company_profiles_bank_account;

SET @company_profiles_bank_ifsc_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'bank_ifsc'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN bank_ifsc VARCHAR(40) NULL AFTER bank_account_number'
  )
);
PREPARE stmt_company_profiles_bank_ifsc FROM @company_profiles_bank_ifsc_sql;
EXECUTE stmt_company_profiles_bank_ifsc;
DEALLOCATE PREPARE stmt_company_profiles_bank_ifsc;

SET @company_profiles_bank_branch_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'company_profiles'
        AND column_name = 'bank_branch'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles ADD COLUMN bank_branch VARCHAR(180) NULL AFTER bank_ifsc'
  )
);
PREPARE stmt_company_profiles_bank_branch FROM @company_profiles_bank_branch_sql;
EXECUTE stmt_company_profiles_bank_branch;
DEALLOCATE PREPARE stmt_company_profiles_bank_branch;

SET @company_profiles_gstin_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'company_profiles'
    AND index_name = 'uq_company_gstin'
);
SET @company_profiles_gstin_index_sql := IF(
  @company_profiles_gstin_index_exists = 0,
  'ALTER TABLE company_profiles ADD UNIQUE KEY uq_company_gstin (gstin)',
  'SELECT 1'
);
PREPARE stmt_company_profiles_gstin_index FROM @company_profiles_gstin_index_sql;
EXECUTE stmt_company_profiles_gstin_index;
DEALLOCATE PREPARE stmt_company_profiles_gstin_index;

SET @company_profiles_phone_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'company_profiles'
    AND index_name = 'uq_company_phone'
);
SET @company_profiles_phone_index_sql := IF(
  @company_profiles_phone_index_exists = 0,
  'ALTER TABLE company_profiles ADD UNIQUE KEY uq_company_phone (phone)',
  'SELECT 1'
);
PREPARE stmt_company_profiles_phone_index FROM @company_profiles_phone_index_sql;
EXECUTE stmt_company_profiles_phone_index;
DEALLOCATE PREPARE stmt_company_profiles_phone_index;

-- ------------------------------------------------------------
-- PERMISSIONS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  permission_key VARCHAR(80) NOT NULL,
  label          VARCHAR(120) NOT NULL,
  module         VARCHAR(60) NOT NULL,
  PRIMARY KEY (permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id         INT UNSIGNED NOT NULL,
  permission_key  VARCHAR(80)  NOT NULL,
  PRIMARY KEY (user_id, permission_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_key) REFERENCES permissions(permission_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS company_invites (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id       INT UNSIGNED NOT NULL,
  user_id          INT UNSIGNED NOT NULL,
  email            VARCHAR(180) NOT NULL,
  role             ENUM('MASTER','ADMIN','NORMAL') NOT NULL DEFAULT 'NORMAL',
  invite_token     VARCHAR(120) NOT NULL,
  invited_by       INT UNSIGNED NULL,
  expires_at       DATETIME NULL,
  accepted_at      DATETIME NULL,
  status           ENUM('PENDING','ACCEPTED','REVOKED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  permissions_json JSON NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_invites_token (invite_token),
  INDEX idx_company_invites_company (company_id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- SESSIONS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED  NOT NULL,
  token      VARCHAR(512)  NOT NULL UNIQUE,
  expires_at DATETIME      NOT NULL,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_token (token),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- PRODUCTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED    NOT NULL,
  code        VARCHAR(20)     NOT NULL UNIQUE,
  name        VARCHAR(200)    NOT NULL,
  hsn_sac_code VARCHAR(20)    NOT NULL,
  product_type ENUM('TRADING_GOODS','MANUFACTURED_GOODS','JOB_WORK_PROCESSING_SERVICE','SERVICES_OTHER') NOT NULL DEFAULT 'TRADING_GOODS',
  category    VARCHAR(100)    NOT NULL,
  unit        VARCHAR(30)     NOT NULL,
  mrp         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  price       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  description TEXT            NULL,
  tax_rate    DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_products_user (user_id),
  INDEX idx_name     (name),
  INDEX idx_category (category),
  INDEX idx_active   (is_active),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @products_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE products ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_products_user_id FROM @products_user_id_sql;
EXECUTE stmt_products_user_id;
DEALLOCATE PREPARE stmt_products_user_id;

SET @products_barcode_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'barcode'
    ),
    'SELECT 1',
    'ALTER TABLE products ADD COLUMN barcode VARCHAR(13) NULL UNIQUE AFTER code'
  )
);
PREPARE stmt_products_barcode FROM @products_barcode_sql;
EXECUTE stmt_products_barcode;
DEALLOCATE PREPARE stmt_products_barcode;

-- ------------------------------------------------------------
-- INVENTORY (stock ledger)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED  NOT NULL,
  code        VARCHAR(20)   NOT NULL UNIQUE,
  date        DATE          NOT NULL,
  reason      VARCHAR(300)  NOT NULL,
  product_id  INT UNSIGNED  NOT NULL,
  current_qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  adjustment  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  new_qty     DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  type        ENUM('MANUAL','SALE','SALE_RETURN','PURCHASE','PURCHASE_RETURN') NOT NULL DEFAULT 'MANUAL',
  ref_id      INT UNSIGNED  NULL,
  ref_code    VARCHAR(20)   NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_inventory_user (user_id),
  INDEX idx_product  (product_id),
  INDEX idx_date     (date),
  INDEX idx_type     (type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @inventory_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'inventory' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE inventory ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_inventory_user_id FROM @inventory_user_id_sql;
EXECUTE stmt_inventory_user_id;
DEALLOCATE PREPARE stmt_inventory_user_id;

-- ------------------------------------------------------------
-- CUSTOMERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED  NOT NULL,
  code        VARCHAR(20)   NOT NULL UNIQUE,
  salutation  VARCHAR(10)   NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  mobile      VARCHAR(20)   NOT NULL,
  address     TEXT          NOT NULL,
  billing_address  TEXT     NULL,
  shipping_address TEXT     NULL,
  email       VARCHAR(180)  NULL,
  gstin       VARCHAR(20)   NULL,
  country     VARCHAR(120)  NOT NULL DEFAULT 'India',
  state_name  VARCHAR(120)  NULL,
  state_code  VARCHAR(2)    NULL,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_customers_user (user_id),
  INDEX idx_name   (name),
  INDEX idx_mobile (mobile),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @customers_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE customers ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_customers_user_id FROM @customers_user_id_sql;
EXECUTE stmt_customers_user_id;
DEALLOCATE PREPARE stmt_customers_user_id;

-- ------------------------------------------------------------
-- INVOICES (Sales)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id             INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED   NOT NULL,
  code           VARCHAR(20)    NOT NULL UNIQUE,
  number         VARCHAR(50)    NOT NULL,
  date           DATE           NOT NULL,
  term           ENUM('CASH','CARD','UPI','CREDIT') NOT NULL DEFAULT 'CASH',
  customer_id    INT UNSIGNED   NOT NULL,
  customer_salutation VARCHAR(10) NULL,
  customer_name  VARCHAR(200)   NULL,
  customer_mobile VARCHAR(20)   NULL,
  customer_email VARCHAR(180)   NULL,
  customer_gstin VARCHAR(20)    NULL,
  customer_billing_address TEXT NULL,
  customer_shipping_address TEXT NULL,
  customer_country VARCHAR(120) NOT NULL DEFAULT 'India',
  customer_state_name VARCHAR(120) NULL,
  customer_state_code VARCHAR(2) NULL,
  place_of_supply_state_name VARCHAR(120) NULL,
  place_of_supply_state_code VARCHAR(2) NULL,
  place_of_supply_country VARCHAR(120) NULL,
  company_state_name VARCHAR(120) NULL,
  company_state_code VARCHAR(2) NULL,
  supply_type   ENUM('INTRA_STATE','INTER_STATE','EXPORT') NOT NULL DEFAULT 'INTRA_STATE',
  is_export     TINYINT(1)      NOT NULL DEFAULT 0,
  price_includes_gst TINYINT(1) NOT NULL DEFAULT 0,
  sub_total      DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount       DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount_type  ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE',
  discount_input DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  taxable_total  DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_cgst     DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_sgst     DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_igst     DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_tax      DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  round_off      DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  grand_total    DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  amount_in_words TEXT          NOT NULL,
  paid_amount    DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  balance        DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  status         ENUM('PAID','PARTIAL','UNPAID') NOT NULL DEFAULT 'UNPAID',
  notes          TEXT           NULL,
  created_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_invoices_user (user_id),
  INDEX idx_customer (customer_id),
  INDEX idx_date     (date),
  INDEX idx_status   (status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @invoices_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'invoices' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE invoices ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_invoices_user_id FROM @invoices_user_id_sql;
EXECUTE stmt_invoices_user_id;
DEALLOCATE PREPARE stmt_invoices_user_id;

-- ------------------------------------------------------------
-- INVOICE ITEMS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_items (
  id          INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED   NOT NULL,
  invoice_id  INT UNSIGNED   NOT NULL,
  product_id  INT UNSIGNED   NOT NULL,
  hsn_sac_code VARCHAR(20)   NOT NULL,
  rate        DECIMAL(12,2)  NOT NULL,
  quantity    DECIMAL(12,2)  NOT NULL,
  base_value  DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  value       DECIMAL(12,2)  NOT NULL,
  tax_rate    DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
  cgst_rate   DECIMAL(6,3)   NOT NULL DEFAULT 0.000,
  cgst_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  sgst_rate   DECIMAL(6,3)   NOT NULL DEFAULT 0.000,
  sgst_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  igst_rate   DECIMAL(6,3)   NOT NULL DEFAULT 0.000,
  igst_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  tax_value   DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_value DECIMAL(12,2)  NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_invoice_items_user (user_id),
  INDEX idx_invoice (invoice_id),
  INDEX idx_product (product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @invoice_items_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'invoice_items' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE invoice_items ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_invoice_items_user_id FROM @invoice_items_user_id_sql;
EXECUTE stmt_invoice_items_user_id;
DEALLOCATE PREPARE stmt_invoice_items_user_id;

-- ------------------------------------------------------------
-- VENDORS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendors (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED  NOT NULL,
  code        VARCHAR(20)   NOT NULL UNIQUE,
  salutation  VARCHAR(10)   NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  mobile      VARCHAR(20)   NOT NULL,
  address     TEXT          NOT NULL,
  billing_address  TEXT     NULL,
  shipping_address TEXT     NULL,
  email       VARCHAR(180)  NULL,
  gstin       VARCHAR(20)   NULL,
  country     VARCHAR(120)  NOT NULL DEFAULT 'India',
  state_name  VARCHAR(120)  NULL,
  state_code  VARCHAR(2)    NULL,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_vendors_user (user_id),
  INDEX idx_name (name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @vendors_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'vendors' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE vendors ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_vendors_user_id FROM @vendors_user_id_sql;
EXECUTE stmt_vendors_user_id;
DEALLOCATE PREPARE stmt_vendors_user_id;

-- ------------------------------------------------------------
-- BILLS (Purchases)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bills (
  id                    INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  user_id               INT UNSIGNED   NOT NULL,
  code                  VARCHAR(20)    NOT NULL UNIQUE,
  vendor_invoice_number VARCHAR(100)   NOT NULL,
  number                VARCHAR(50)    NOT NULL,
  date                  DATE           NOT NULL,
  term                  ENUM('CASH','CARD','UPI','CREDIT') NOT NULL DEFAULT 'CASH',
  vendor_id             INT UNSIGNED   NOT NULL,
  vendor_salutation     VARCHAR(10)    NULL,
  vendor_name           VARCHAR(200)   NULL,
  vendor_mobile         VARCHAR(20)    NULL,
  vendor_email          VARCHAR(180)   NULL,
  vendor_gstin          VARCHAR(20)    NULL,
  vendor_billing_address TEXT          NULL,
  vendor_shipping_address TEXT         NULL,
  vendor_country        VARCHAR(120)   NOT NULL DEFAULT 'India',
  vendor_state_name     VARCHAR(120)   NULL,
  vendor_state_code     VARCHAR(2)     NULL,
  place_of_supply_state_name VARCHAR(120) NULL,
  place_of_supply_state_code VARCHAR(2)   NULL,
  place_of_supply_country VARCHAR(120)    NULL,
  company_state_name    VARCHAR(120)   NULL,
  company_state_code    VARCHAR(2)     NULL,
  supply_type           ENUM('INTRA_STATE','INTER_STATE','IMPORT') NOT NULL DEFAULT 'INTRA_STATE',
  is_import             TINYINT(1)     NOT NULL DEFAULT 0,
  price_includes_gst    TINYINT(1)     NOT NULL DEFAULT 0,
  sub_total             DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount              DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount_type         ENUM('PERCENTAGE','AMOUNT') NOT NULL DEFAULT 'PERCENTAGE',
  discount_input        DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  taxable_total         DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_cgst            DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_sgst            DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_igst            DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_tax             DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  round_off             DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  grand_total           DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  amount_in_words       TEXT           NOT NULL,
  paid_amount           DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  balance               DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  status                ENUM('PAID','PARTIAL','UNPAID') NOT NULL DEFAULT 'UNPAID',
  notes                 TEXT           NULL,
  created_at            DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_bills_user (user_id),
  INDEX idx_vendor (vendor_id),
  INDEX idx_date   (date),
  INDEX idx_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @bills_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE bills ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_bills_user_id FROM @bills_user_id_sql;
EXECUTE stmt_bills_user_id;
DEALLOCATE PREPARE stmt_bills_user_id;

-- ------------------------------------------------------------
-- BILL ITEMS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bill_items (
  id          INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED   NOT NULL,
  bill_id     INT UNSIGNED   NOT NULL,
  product_id  INT UNSIGNED   NOT NULL,
  hsn_sac_code VARCHAR(20)   NOT NULL,
  rate        DECIMAL(12,2)  NOT NULL,
  quantity    DECIMAL(12,2)  NOT NULL,
  base_value  DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  value       DECIMAL(12,2)  NOT NULL,
  tax_rate    DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
  cgst_rate   DECIMAL(6,3)   NOT NULL DEFAULT 0.000,
  cgst_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  sgst_rate   DECIMAL(6,3)   NOT NULL DEFAULT 0.000,
  sgst_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  igst_rate   DECIMAL(6,3)   NOT NULL DEFAULT 0.000,
  igst_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  tax_value   DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  total_value DECIMAL(12,2)  NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_bill_items_user (user_id),
  INDEX idx_bill    (bill_id),
  INDEX idx_product (product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_id)    REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @bill_items_user_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE bill_items ADD COLUMN user_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_bill_items_user_id FROM @bill_items_user_id_sql;
EXECUTE stmt_bill_items_user_id;
DEALLOCATE PREPARE stmt_bill_items_user_id;

-- ------------------------------------------------------------
-- HSN / SAC MASTER
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hsn_sac_master (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                VARCHAR(20) NOT NULL,
  description         VARCHAR(500) NOT NULL,
  suggested_gst_rate  DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  entry_type          ENUM('GOODS','SERVICE','JOBWORK') NOT NULL DEFAULT 'GOODS',
  chapter             VARCHAR(50) NULL,
  keywords            TEXT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hsn_sac_master_code (code),
  INDEX idx_hsn_sac_type (entry_type),
  INDEX idx_hsn_sac_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hsn_sac_requests (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             INT UNSIGNED NOT NULL,
  code                VARCHAR(20) NOT NULL,
  description         VARCHAR(500) NULL,
  requested_for_type  ENUM('GOODS','SERVICE','JOBWORK') NOT NULL DEFAULT 'GOODS',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_hsn_sac_requests_user (user_id),
  INDEX idx_hsn_sac_requests_code (code),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- ACTIVITY LOG
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED  NOT NULL,
  type         VARCHAR(60)   NOT NULL,
  entity_id    INT UNSIGNED  NULL,
  entity_code  VARCHAR(20)   NULL,
  description  VARCHAR(500)  NOT NULL,
  metadata     JSON          NULL,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_user      (user_id),
  INDEX idx_type      (type),
  INDEX idx_created   (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- SUBSCRIPTION LOGS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_logs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id     INT UNSIGNED NULL,
  user_id       INT UNSIGNED NOT NULL,
  changed_by    INT UNSIGNED NULL,
  action        ENUM('TRIAL_STARTED','ACTIVATED','SUSPENDED','REACTIVATED','EXPIRED') NOT NULL,
  plan          ENUM('TRIAL','MONTHLY','YEARLY') NOT NULL,
  notes         TEXT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_subscription_logs_company (company_id),
  INDEX idx_subscription_logs_user (user_id),
  INDEX idx_subscription_logs_action (action),
  INDEX idx_subscription_logs_created (created_at),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @subscription_logs_company_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'subscription_logs'
        AND column_name = 'company_id'
    ),
    'SELECT 1',
    'ALTER TABLE subscription_logs ADD COLUMN company_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_subscription_logs_company_id FROM @subscription_logs_company_id_sql;
EXECUTE stmt_subscription_logs_company_id;
DEALLOCATE PREPARE stmt_subscription_logs_company_id;

-- ------------------------------------------------------------
-- PAYMENT REQUESTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_requests (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id      INT UNSIGNED NULL,
  user_id         INT UNSIGNED NOT NULL,
  plan            ENUM('MONTHLY','YEARLY') NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  payment_mode    ENUM('UPI','CASH') NOT NULL,
  payer_contact   VARCHAR(120) NULL,
  upi_ref         VARCHAR(200) NULL,
  screenshot_path VARCHAR(500) NULL,
  status          ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  admin_notes     TEXT NULL,
  reviewed_by     INT UNSIGNED NULL,
  reviewed_at     DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_payment_requests_company (company_id),
  INDEX idx_payment_requests_user (user_id),
  INDEX idx_payment_requests_status (status),
  INDEX idx_payment_requests_created (created_at),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @payment_requests_company_id_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'payment_requests'
        AND column_name = 'company_id'
    ),
    'SELECT 1',
    'ALTER TABLE payment_requests ADD COLUMN company_id INT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt_payment_requests_company_id FROM @payment_requests_company_id_sql;
EXECUTE stmt_payment_requests_company_id;
DEALLOCATE PREPARE stmt_payment_requests_company_id;

INSERT INTO permissions (permission_key, label, module) VALUES
  ('can_view_dashboard', 'View Dashboard', 'dashboard'),
  ('can_list_products', 'List Products', 'products'),
  ('can_view_products', 'View Products', 'products'),
  ('can_add_products', 'Add Products', 'products'),
  ('can_edit_products', 'Edit Products', 'products'),
  ('can_delete_products', 'Delete Products', 'products'),
  ('can_list_inventory', 'List Inventory', 'inventory'),
  ('can_view_inventory', 'View Inventory', 'inventory'),
  ('can_add_inventory', 'Add Inventory', 'inventory'),
  ('can_list_customers', 'List Customers', 'customers'),
  ('can_view_customers', 'View Customers', 'customers'),
  ('can_add_customers', 'Add Customers', 'customers'),
  ('can_edit_customers', 'Edit Customers', 'customers'),
  ('can_delete_customers', 'Delete Customers', 'customers'),
  ('can_list_vendors', 'List Vendors', 'vendors'),
  ('can_view_vendors', 'View Vendors', 'vendors'),
  ('can_add_vendors', 'Add Vendors', 'vendors'),
  ('can_edit_vendors', 'Edit Vendors', 'vendors'),
  ('can_delete_vendors', 'Delete Vendors', 'vendors'),
  ('can_list_invoices', 'List Invoices', 'invoices'),
  ('can_view_invoices', 'View Invoices', 'invoices'),
  ('can_add_invoices', 'Add Invoices', 'invoices'),
  ('can_edit_invoices', 'Edit Invoices', 'invoices'),
  ('can_delete_invoices', 'Delete Invoices', 'invoices'),
  ('can_list_bills', 'List Bills', 'bills'),
  ('can_view_bills', 'View Bills', 'bills'),
  ('can_add_bills', 'Add Bills', 'bills'),
  ('can_edit_bills', 'Edit Bills', 'bills'),
  ('can_delete_bills', 'Delete Bills', 'bills'),
  ('can_list_reports', 'List Reports', 'reports'),
  ('can_view_reports', 'View Reports', 'reports'),
  ('can_view_company', 'View Company', 'company'),
  ('can_edit_company', 'Edit Company', 'company'),
  ('can_list_users', 'List Users', 'users'),
  ('can_view_users', 'View Users', 'users'),
  ('can_add_users', 'Add Users', 'users'),
  ('can_edit_users', 'Edit Users', 'users'),
  ('can_delete_users', 'Delete Users', 'users'),
  ('can_manage_products', 'Manage Products (Legacy)', 'products'),
  ('can_manage_inventory', 'Manage Inventory (Legacy)', 'inventory'),
  ('can_manage_customers', 'Manage Customers (Legacy)', 'customers'),
  ('can_manage_vendors', 'Manage Vendors (Legacy)', 'vendors'),
  ('can_manage_invoices', 'Manage Invoices (Legacy)', 'invoices'),
  ('can_manage_bills', 'Manage Bills (Legacy)', 'bills'),
  ('can_manage_company', 'Manage Company (Legacy)', 'company'),
  ('can_manage_users', 'Manage Users (Legacy)', 'users')
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  module = VALUES(module);

INSERT IGNORE INTO companies (
  owner_user_id,
  name,
  created_by_admin,
  subscription_plan,
  subscription_status,
  trial_ends_at,
  subscription_ends_at,
  created_at,
  updated_at
)
SELECT
  u.id,
  COALESCE(cp.name, CONCAT(u.name, '''s Business')),
  0,
  'TRIAL',
  'ACTIVE',
  NULL,
  NULL,
  u.created_at,
  u.updated_at
FROM users u
LEFT JOIN company_profiles cp ON cp.user_id = u.id
WHERE u.is_platform_admin = 0;

UPDATE users
SET role = CASE
  WHEN role = 'OWNER' THEN 'MASTER'
  WHEN role = 'STAFF' THEN 'NORMAL'
  ELSE role
END
WHERE is_platform_admin = 0;

UPDATE users
SET status = 'ACTIVE'
WHERE status IS NULL;

UPDATE users u
INNER JOIN companies c ON c.owner_user_id = u.id
SET
  u.company_id = c.id,
  u.password_set_at = COALESCE(u.password_set_at, CASE WHEN u.password_hash IS NOT NULL THEN u.updated_at ELSE NULL END)
WHERE u.company_id IS NULL
  AND u.is_platform_admin = 0;

UPDATE company_profiles cp
INNER JOIN users u ON u.id = cp.user_id
SET cp.company_id = u.company_id
WHERE cp.company_id IS NULL;

UPDATE subscription_logs sl
INNER JOIN users u ON u.id = sl.user_id
SET sl.company_id = u.company_id
WHERE sl.company_id IS NULL;

UPDATE payment_requests pr
INNER JOIN users u ON u.id = pr.user_id
SET pr.company_id = u.company_id
WHERE pr.company_id IS NULL;

SET @seed_platform_admin_email := 'admin@trihub.app';
SET @seed_platform_admin_password_hash := '$2a$12$Z6at4KM72SZx7mSkxl98LuTpK3I9aCamG.5o.Zxkp3XvkYwX8/6jW';
SET @seed_platform_admin_name := 'TriHub Platform Admin';
SET @seed_platform_admin_expires_at := DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 25 YEAR);

INSERT IGNORE INTO users (
  email,
  password_hash,
  auth_provider,
  name,
  role,
  is_platform_admin
) VALUES (
  @seed_platform_admin_email,
  @seed_platform_admin_password_hash,
  'LOCAL',
  @seed_platform_admin_name,
  'ADMIN',
  1
);

UPDATE users
SET
  password_hash = @seed_platform_admin_password_hash,
  auth_provider = 'LOCAL',
  name = @seed_platform_admin_name,
  role = 'ADMIN',
  is_platform_admin = 1
WHERE email = @seed_platform_admin_email;

-- ------------------------------------------------------------
-- PLATFORM SETTINGS (admin-configurable key-value store)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key   VARCHAR(100)  NOT NULL,
  setting_value TEXT          NULL,
  updated_by    INT UNSIGNED  NULL,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- COMPANY CHATS (Internal Chat Environment)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_chats (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT UNSIGNED NOT NULL,
  sender_id INT UNSIGNED NOT NULL,
  message TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- COMPANY FEEDBACKS (Subscription Feedback)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_feedbacks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  rating INT NOT NULL CHECK(rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @customers_balance_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'balance'
    ),
    'SELECT 1',
    'ALTER TABLE customers ADD COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0.00'
  )
);
PREPARE stmt_customers_balance FROM @customers_balance_sql;
EXECUTE stmt_customers_balance;
DEALLOCATE PREPARE stmt_customers_balance;

SET @invoices_prev_balance_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'invoices' AND column_name = 'previous_balance'
    ),
    'SELECT 1',
    'ALTER TABLE invoices ADD COLUMN previous_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00'
  )
);
PREPARE stmt_invoices_prev_balance FROM @invoices_prev_balance_sql;
EXECUTE stmt_invoices_prev_balance;
DEALLOCATE PREPARE stmt_invoices_prev_balance;

SET @vendors_balance_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'vendors' AND column_name = 'balance'
    ),
    'SELECT 1',
    'ALTER TABLE vendors ADD COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0.00'
  )
);
PREPARE stmt_vendors_balance FROM @vendors_balance_sql;
EXECUTE stmt_vendors_balance;
DEALLOCATE PREPARE stmt_vendors_balance;

SET @bills_prev_balance_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'previous_balance'
    ),
    'SELECT 1',
    'ALTER TABLE bills ADD COLUMN previous_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00'
  )
);
PREPARE stmt_bills_prev_balance FROM @bills_prev_balance_sql;
EXECUTE stmt_bills_prev_balance;
DEALLOCATE PREPARE stmt_bills_prev_balance;

SET @company_profiles_gst_state_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'company_profiles' AND column_name = 'state_code'
    ),
    'SELECT 1',
    'ALTER TABLE company_profiles
      ADD COLUMN state_code VARCHAR(2) NULL AFTER gstin,
      ADD COLUMN state_name VARCHAR(120) NULL AFTER state_code'
  )
);
PREPARE stmt_company_profiles_gst_state FROM @company_profiles_gst_state_sql;
EXECUTE stmt_company_profiles_gst_state;
DEALLOCATE PREPARE stmt_company_profiles_gst_state;

SET @products_hsn_sac_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'hsn_sac_code'
    ),
    'SELECT 1',
    'ALTER TABLE products
      ADD COLUMN hsn_sac_code VARCHAR(20) NOT NULL DEFAULT "" AFTER name'
  )
);
PREPARE stmt_products_hsn_sac FROM @products_hsn_sac_sql;
EXECUTE stmt_products_hsn_sac;
DEALLOCATE PREPARE stmt_products_hsn_sac;

SET @products_type_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'product_type'
    ),
    'SELECT 1',
    'ALTER TABLE products
      ADD COLUMN product_type ENUM("TRADING_GOODS","MANUFACTURED_GOODS","JOB_WORK_PROCESSING_SERVICE","SERVICES_OTHER")
      NOT NULL DEFAULT "TRADING_GOODS" AFTER hsn_sac_code'
  )
);
PREPARE stmt_products_type FROM @products_type_sql;
EXECUTE stmt_products_type;
DEALLOCATE PREPARE stmt_products_type;

SET @customers_gst_master_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'billing_address'
    ),
    'SELECT 1',
    'ALTER TABLE customers
      ADD COLUMN billing_address TEXT NULL AFTER address,
      ADD COLUMN shipping_address TEXT NULL AFTER billing_address,
      ADD COLUMN country VARCHAR(120) NOT NULL DEFAULT "India" AFTER gstin,
      ADD COLUMN state_name VARCHAR(120) NULL AFTER country,
      ADD COLUMN state_code VARCHAR(2) NULL AFTER state_name'
  )
);
PREPARE stmt_customers_gst_master FROM @customers_gst_master_sql;
EXECUTE stmt_customers_gst_master;
DEALLOCATE PREPARE stmt_customers_gst_master;

SET @vendors_gst_master_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'vendors' AND column_name = 'billing_address'
    ),
    'SELECT 1',
    'ALTER TABLE vendors
      ADD COLUMN billing_address TEXT NULL AFTER address,
      ADD COLUMN shipping_address TEXT NULL AFTER billing_address,
      ADD COLUMN country VARCHAR(120) NOT NULL DEFAULT "India" AFTER gstin,
      ADD COLUMN state_name VARCHAR(120) NULL AFTER country,
      ADD COLUMN state_code VARCHAR(2) NULL AFTER state_name'
  )
);
PREPARE stmt_vendors_gst_master FROM @vendors_gst_master_sql;
EXECUTE stmt_vendors_gst_master;
DEALLOCATE PREPARE stmt_vendors_gst_master;

SET @invoices_gst_snapshot_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'invoices' AND column_name = 'taxable_total'
    ),
    'SELECT 1',
    'ALTER TABLE invoices
      ADD COLUMN customer_salutation VARCHAR(10) NULL AFTER customer_id,
      ADD COLUMN customer_name VARCHAR(200) NULL AFTER customer_salutation,
      ADD COLUMN customer_mobile VARCHAR(20) NULL AFTER customer_name,
      ADD COLUMN customer_email VARCHAR(180) NULL AFTER customer_mobile,
      ADD COLUMN customer_gstin VARCHAR(20) NULL AFTER customer_email,
      ADD COLUMN customer_billing_address TEXT NULL AFTER customer_gstin,
      ADD COLUMN customer_shipping_address TEXT NULL AFTER customer_billing_address,
      ADD COLUMN customer_country VARCHAR(120) NOT NULL DEFAULT "India" AFTER customer_shipping_address,
      ADD COLUMN customer_state_name VARCHAR(120) NULL AFTER customer_country,
      ADD COLUMN customer_state_code VARCHAR(2) NULL AFTER customer_state_name,
      ADD COLUMN place_of_supply_state_name VARCHAR(120) NULL AFTER customer_state_code,
      ADD COLUMN place_of_supply_state_code VARCHAR(2) NULL AFTER place_of_supply_state_name,
      ADD COLUMN place_of_supply_country VARCHAR(120) NULL AFTER place_of_supply_state_code,
      ADD COLUMN company_state_name VARCHAR(120) NULL AFTER place_of_supply_country,
      ADD COLUMN company_state_code VARCHAR(2) NULL AFTER company_state_name,
      ADD COLUMN supply_type ENUM("INTRA_STATE","INTER_STATE","EXPORT") NOT NULL DEFAULT "INTRA_STATE" AFTER company_state_code,
      ADD COLUMN is_export TINYINT(1) NOT NULL DEFAULT 0 AFTER supply_type,
      ADD COLUMN price_includes_gst TINYINT(1) NOT NULL DEFAULT 0 AFTER is_export,
      ADD COLUMN taxable_total DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount,
      ADD COLUMN total_cgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER taxable_total,
      ADD COLUMN total_sgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cgst,
      ADD COLUMN total_igst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_sgst'
  )
);
PREPARE stmt_invoices_gst_snapshot FROM @invoices_gst_snapshot_sql;
EXECUTE stmt_invoices_gst_snapshot;
DEALLOCATE PREPARE stmt_invoices_gst_snapshot;

SET @invoice_items_gst_breakup_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'invoice_items' AND column_name = 'hsn_sac_code'
    ),
    'SELECT 1',
    'ALTER TABLE invoice_items
      ADD COLUMN hsn_sac_code VARCHAR(20) NOT NULL DEFAULT "" AFTER product_id,
      ADD COLUMN base_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER quantity,
      ADD COLUMN discount_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER base_value,
      ADD COLUMN taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_value,
      ADD COLUMN cgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER tax_rate,
      ADD COLUMN cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER cgst_rate,
      ADD COLUMN sgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER cgst_amount,
      ADD COLUMN sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER sgst_rate,
      ADD COLUMN igst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER sgst_amount,
      ADD COLUMN igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER igst_rate'
  )
);
PREPARE stmt_invoice_items_gst_breakup FROM @invoice_items_gst_breakup_sql;
EXECUTE stmt_invoice_items_gst_breakup;
DEALLOCATE PREPARE stmt_invoice_items_gst_breakup;

SET @bills_gst_snapshot_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'taxable_total'
    ),
    'SELECT 1',
    'ALTER TABLE bills
      ADD COLUMN vendor_salutation VARCHAR(10) NULL AFTER vendor_id,
      ADD COLUMN vendor_name VARCHAR(200) NULL AFTER vendor_salutation,
      ADD COLUMN vendor_mobile VARCHAR(20) NULL AFTER vendor_name,
      ADD COLUMN vendor_email VARCHAR(180) NULL AFTER vendor_mobile,
      ADD COLUMN vendor_gstin VARCHAR(20) NULL AFTER vendor_email,
      ADD COLUMN vendor_billing_address TEXT NULL AFTER vendor_gstin,
      ADD COLUMN vendor_shipping_address TEXT NULL AFTER vendor_billing_address,
      ADD COLUMN vendor_country VARCHAR(120) NOT NULL DEFAULT "India" AFTER vendor_shipping_address,
      ADD COLUMN vendor_state_name VARCHAR(120) NULL AFTER vendor_country,
      ADD COLUMN vendor_state_code VARCHAR(2) NULL AFTER vendor_state_name,
      ADD COLUMN place_of_supply_state_name VARCHAR(120) NULL AFTER vendor_state_code,
      ADD COLUMN place_of_supply_state_code VARCHAR(2) NULL AFTER place_of_supply_state_name,
      ADD COLUMN place_of_supply_country VARCHAR(120) NULL AFTER place_of_supply_state_code,
      ADD COLUMN company_state_name VARCHAR(120) NULL AFTER place_of_supply_country,
      ADD COLUMN company_state_code VARCHAR(2) NULL AFTER company_state_name,
      ADD COLUMN supply_type ENUM("INTRA_STATE","INTER_STATE","IMPORT") NOT NULL DEFAULT "INTRA_STATE" AFTER company_state_code,
      ADD COLUMN is_import TINYINT(1) NOT NULL DEFAULT 0 AFTER supply_type,
      ADD COLUMN price_includes_gst TINYINT(1) NOT NULL DEFAULT 0 AFTER is_import,
      ADD COLUMN taxable_total DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount,
      ADD COLUMN total_cgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER taxable_total,
      ADD COLUMN total_sgst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cgst,
      ADD COLUMN total_igst DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_sgst'
  )
);
PREPARE stmt_bills_gst_snapshot FROM @bills_gst_snapshot_sql;
EXECUTE stmt_bills_gst_snapshot;
DEALLOCATE PREPARE stmt_bills_gst_snapshot;

SET @bill_items_gst_breakup_sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'hsn_sac_code'
    ),
    'SELECT 1',
    'ALTER TABLE bill_items
      ADD COLUMN hsn_sac_code VARCHAR(20) NOT NULL DEFAULT "" AFTER product_id,
      ADD COLUMN base_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER quantity,
      ADD COLUMN discount_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER base_value,
      ADD COLUMN taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount_value,
      ADD COLUMN cgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER tax_rate,
      ADD COLUMN cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER cgst_rate,
      ADD COLUMN sgst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER cgst_amount,
      ADD COLUMN sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER sgst_rate,
      ADD COLUMN igst_rate DECIMAL(6,3) NOT NULL DEFAULT 0.000 AFTER sgst_amount,
      ADD COLUMN igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER igst_rate'
  )
);
PREPARE stmt_bill_items_gst_breakup FROM @bill_items_gst_breakup_sql;
EXECUTE stmt_bill_items_gst_breakup;
DEALLOCATE PREPARE stmt_bill_items_gst_breakup;

INSERT INTO hsn_sac_master (code, description, suggested_gst_rate, entry_type, chapter, keywords) VALUES
  ('9988', 'Manufacturing services on physical inputs owned by others', 5.00, 'JOBWORK', 'SAC 9988', 'job work processing stitching dyeing printing finishing contract manufacturing'),
  ('9954', 'Construction services', 18.00, 'SERVICE', 'SAC 9954', 'construction civil contractor building work'),
  ('9983', 'Other professional, technical and business services', 18.00, 'SERVICE', 'SAC 9983', 'consulting professional technical business advisory'),
  ('998313', 'Information technology consulting and support services', 18.00, 'SERVICE', 'SAC 9983', 'software development it consulting implementation support'),
  ('998314', 'IT design and development services', 18.00, 'SERVICE', 'SAC 9983', 'software app website development programming coding'),
  ('996511', 'Road transport services of goods', 5.00, 'SERVICE', 'SAC 9965', 'transport freight logistics trucking delivery'),
  ('996601', 'Rental services of transport vehicles', 18.00, 'SERVICE', 'SAC 9966', 'vehicle rental transport hire'),
  ('997212', 'Accounting and bookkeeping services', 18.00, 'SERVICE', 'SAC 9972', 'accounting bookkeeping gst filing audit'),
  ('997331', 'Licensing services for software and databases', 18.00, 'SERVICE', 'SAC 9973', 'software license saas subscription'),
  ('999293', 'Laundry, cleaning and dyeing services', 18.00, 'SERVICE', 'SAC 9992', 'laundry dry clean dyeing cleaning'),
  ('1001', 'Wheat and meslin', 0.00, 'GOODS', 'Chapter 10', 'wheat grain cereal'),
  ('1701', 'Cane or beet sugar and chemically pure sucrose', 5.00, 'GOODS', 'Chapter 17', 'sugar sweetener'),
  ('2402', 'Cigars, cheroots, cigarillos and cigarettes', 28.00, 'GOODS', 'Chapter 24', 'cigarette tobacco smoking'),
  ('3004', 'Medicaments for therapeutic or prophylactic uses', 12.00, 'GOODS', 'Chapter 30', 'medicine pharma tablet syrup drug'),
  ('3304', 'Beauty or make-up preparations and skin care', 18.00, 'GOODS', 'Chapter 33', 'cosmetics beauty makeup skincare'),
  ('3901', 'Polymers of ethylene in primary forms', 18.00, 'GOODS', 'Chapter 39', 'plastic polymer granules resin'),
  ('4411', 'Fibreboard of wood or other ligneous materials', 18.00, 'GOODS', 'Chapter 44', 'board mdf plywood fibre wood'),
  ('4819', 'Cartons, boxes and packing containers of paper', 12.00, 'GOODS', 'Chapter 48', 'paper box carton packaging corrugated'),
  ('5208', 'Woven fabrics of cotton', 5.00, 'GOODS', 'Chapter 52', 'cotton fabric textile cloth'),
  ('6109', 'T-shirts, singlets and other vests, knitted or crocheted', 5.00, 'GOODS', 'Chapter 61', 'tshirt t-shirt vest knitwear garment apparel'),
  ('6203', 'Mens or boys suits, ensembles, jackets and trousers', 12.00, 'GOODS', 'Chapter 62', 'mens garments trousers jackets apparel'),
  ('6403', 'Footwear with outer soles of rubber, plastics or leather', 18.00, 'GOODS', 'Chapter 64', 'shoes footwear sandals'),
  ('7308', 'Structures and parts of structures, of iron or steel', 18.00, 'GOODS', 'Chapter 73', 'steel structure fabrication beam frame'),
  ('8471', 'Automatic data processing machines and units thereof', 18.00, 'GOODS', 'Chapter 84', 'computer laptop cpu server hardware'),
  ('8504', 'Electrical transformers, static converters and inductors', 18.00, 'GOODS', 'Chapter 85', 'transformer inverter charger electrical'),
  ('8517', 'Telephone sets, smartphones and communication apparatus', 18.00, 'GOODS', 'Chapter 85', 'mobile phone smartphone telecom'),
  ('8708', 'Parts and accessories of motor vehicles', 28.00, 'GOODS', 'Chapter 87', 'automobile spare parts vehicle accessories'),
  ('9403', 'Other furniture and parts thereof', 18.00, 'GOODS', 'Chapter 94', 'furniture table chair cabinet'),
  ('9603', 'Brooms, brushes and mops', 12.00, 'GOODS', 'Chapter 96', 'brush broom mop cleaning')
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  suggested_gst_rate = VALUES(suggested_gst_rate),
  entry_type = VALUES(entry_type),
  chapter = VALUES(chapter),
  keywords = VALUES(keywords),
  is_active = 1;

SET FOREIGN_KEY_CHECKS = 1;
