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
  pan         VARCHAR(15)   NULL,
  website     VARCHAR(300)  NULL,
  upi_id      VARCHAR(100)  NULL,        -- used in QR code generation
  upi_name    VARCHAR(120)  NULL,        -- merchant display name for UPI
  upi_qr_image VARCHAR(500) NULL,
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
  email       VARCHAR(180)  NULL,
  gstin       VARCHAR(20)   NULL,
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
  sub_total      DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount       DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
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
  rate        DECIMAL(12,2)  NOT NULL,
  quantity    DECIMAL(12,2)  NOT NULL,
  value       DECIMAL(12,2)  NOT NULL,
  tax_rate    DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
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
  email       VARCHAR(180)  NULL,
  gstin       VARCHAR(20)   NULL,
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
  sub_total             DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  discount              DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
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
  rate        DECIMAL(12,2)  NOT NULL,
  quantity    DECIMAL(12,2)  NOT NULL,
  value       DECIMAL(12,2)  NOT NULL,
  tax_rate    DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
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

SET FOREIGN_KEY_CHECKS = 1;
