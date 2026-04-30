const MODULE_ACTIONS = {
  dashboard: ["view"],
  products: ["list", "view", "add", "edit", "delete"],
  inventory: ["list", "view", "add"],
  customers: ["list", "view", "add", "edit", "delete"],
  vendors: ["list", "view", "add", "edit", "delete"],
  invoices: ["list", "view", "add", "edit", "delete"],
  bills: ["list", "view", "add", "edit", "delete"],
  reports: ["list", "view"],
  company: ["view", "edit"],
  users: ["list", "view", "add", "edit", "delete"],
};

function buildPermissionKey(action, moduleKey) {
  return `can_${action}_${moduleKey}`;
}

function buildModulePermissions(moduleKey) {
  return (MODULE_ACTIONS[moduleKey] || []).map((action) => buildPermissionKey(action, moduleKey));
}

const ALL_PERMISSION_KEYS = Object.keys(MODULE_ACTIONS).flatMap((moduleKey) => buildModulePermissions(moduleKey));

const LEGACY_PERMISSION_EXPANSIONS = {
  can_view_dashboard: buildModulePermissions("dashboard"),
  can_manage_products: buildModulePermissions("products"),
  can_manage_inventory: buildModulePermissions("inventory"),
  can_manage_customers: buildModulePermissions("customers"),
  can_manage_vendors: buildModulePermissions("vendors"),
  can_manage_invoices: buildModulePermissions("invoices"),
  can_manage_bills: buildModulePermissions("bills"),
  can_view_reports: buildModulePermissions("reports"),
  can_manage_company: buildModulePermissions("company"),
  can_manage_users: buildModulePermissions("users"),
};

const LEGACY_PERMISSION_DEFINITIONS = [
  { key: "can_manage_products", label: "Manage Products (Legacy)", module: "products" },
  { key: "can_manage_inventory", label: "Manage Inventory (Legacy)", module: "inventory" },
  { key: "can_manage_customers", label: "Manage Customers (Legacy)", module: "customers" },
  { key: "can_manage_vendors", label: "Manage Vendors (Legacy)", module: "vendors" },
  { key: "can_manage_invoices", label: "Manage Invoices (Legacy)", module: "invoices" },
  { key: "can_manage_bills", label: "Manage Bills (Legacy)", module: "bills" },
  { key: "can_manage_company", label: "Manage Company (Legacy)", module: "company" },
  { key: "can_manage_users", label: "Manage Users (Legacy)", module: "users" },
];

const PERMISSION_DEFINITIONS = [
  { key: "can_view_dashboard", label: "View Dashboard", module: "dashboard", action: "view" },
  ...Object.entries(MODULE_ACTIONS)
    .filter(([moduleKey]) => moduleKey !== "dashboard")
    .flatMap(([moduleKey, actions]) =>
      actions.map((action) => ({
        key: buildPermissionKey(action, moduleKey),
        label: `${action.charAt(0).toUpperCase()}${action.slice(1)} ${moduleKey.charAt(0).toUpperCase()}${moduleKey.slice(1)}`,
        module: moduleKey,
        action,
      }))
    ),
];

function normalizeRole(role) {
  switch (role) {
    case "OWNER":
      return "MASTER";
    case "STAFF":
      return "NORMAL";
    default:
      return role || "NORMAL";
  }
}

function expandPermissionKey(permissionKey) {
  if (LEGACY_PERMISSION_EXPANSIONS[permissionKey]) {
    return LEGACY_PERMISSION_EXPANSIONS[permissionKey];
  }

  if (ALL_PERMISSION_KEYS.includes(permissionKey)) {
    return [permissionKey];
  }

  return [];
}

function expandPermissionKeys(values = []) {
  return (values || []).flatMap((value) => expandPermissionKey(value));
}

function cleanPermissionList(values = []) {
  return [...new Set(expandPermissionKeys(values))].sort();
}

const ROLE_DEFAULT_PERMISSIONS = {
  MASTER: [...ALL_PERMISSION_KEYS],
  ADMIN: cleanPermissionList([
    ...buildModulePermissions("dashboard"),
    ...buildModulePermissions("products"),
    ...buildModulePermissions("inventory"),
    ...buildModulePermissions("customers"),
    ...buildModulePermissions("vendors"),
    ...buildModulePermissions("invoices"),
    ...buildModulePermissions("bills"),
    ...buildModulePermissions("reports"),
  ]),
  NORMAL: [],
};

function getDefaultPermissionsForRole(role) {
  if (role === "MASTER") {
    return [...ALL_PERMISSION_KEYS];
  }

  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

function getEffectivePermissions(role, assignedPermissions = []) {
  if (role === "MASTER") {
    return [...ALL_PERMISSION_KEYS];
  }

  return cleanPermissionList([
    ...getDefaultPermissionsForRole(role),
    ...(assignedPermissions || []),
  ]);
}

function hasPermission(permissions = [], permissionKey) {
  return cleanPermissionList(permissions).includes(permissionKey);
}

async function syncPermissionCatalog(executor) {
  const definitions = [...PERMISSION_DEFINITIONS, ...LEGACY_PERMISSION_DEFINITIONS];

  if (!definitions.length) {
    return;
  }

  const values = definitions.map(() => "(?, ?, ?)").join(", ");
  const params = definitions.flatMap((definition) => [definition.key, definition.label, definition.module]);

  await executor.execute(
    `INSERT INTO permissions (permission_key, label, module)
     VALUES ${values}
     ON DUPLICATE KEY UPDATE
       label = VALUES(label),
       module = VALUES(module)`,
    params
  );
}

async function getUserPermissions(executor, userId) {
  const [rows] = await executor.execute(
    "SELECT permission_key FROM user_permissions WHERE user_id = ? ORDER BY permission_key",
    [userId]
  );

  return rows.map((row) => row.permission_key);
}

async function loadTenantUser(executor, userId) {
  const [[row]] = await executor.execute(
    `SELECT
       u.id AS member_id,
       u.company_id,
       u.email,
       u.password_hash,
       u.auth_provider,
       u.google_sub,
       u.email_verified_at,
       u.name,
       u.salutation,
       u.dob,
       u.designation,
       u.mobile,
       u.profile_picture,
       u.role,
       u.status,
       u.must_change_password,
       u.is_platform_admin,
       u.created_at,
       c.owner_user_id,
       c.name AS company_name,
       c.subscription_plan,
       c.subscription_status,
       c.trial_ends_at,
       c.subscription_ends_at,
       c.created_by_admin
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [userId]
  );

  if (!row) {
    return null;
  }

  const normalizedRole = normalizeRole(row.role);
  const permissions = row.is_platform_admin
    ? [...ALL_PERMISSION_KEYS]
    : getEffectivePermissions(normalizedRole, await getUserPermissions(executor, row.member_id));

  return {
    ...row,
    id: row.member_id,
    role: normalizedRole,
    scope_user_id: row.is_platform_admin ? row.member_id : row.owner_user_id || row.member_id,
    permissions,
    sub_plan: row.subscription_plan || "TRIAL",
    sub_status: row.subscription_status || "ACTIVE",
    sub_ends_at: row.subscription_ends_at,
  };
}

async function loadCompanyProfile(executor, companyId) {
  if (!companyId) return null;

  const [[company]] = await executor.execute(
    `SELECT
       c.id,
       c.name,
       c.owner_user_id,
       c.subscription_plan AS sub_plan,
       c.subscription_status AS sub_status,
       c.trial_ends_at,
       c.subscription_ends_at AS sub_ends_at,
       c.created_by_admin,
       cp.logo,
       cp.address,
       cp.phone,
       cp.email,
       cp.gstin,
       cp.pan,
       cp.website,
       cp.upi_id,
       cp.upi_name,
       cp.upi_qr_image,
       cp.storage_used_bytes,
       c.created_at,
       c.updated_at
     FROM companies c
     LEFT JOIN company_profiles cp ON cp.company_id = c.id
     WHERE c.id = ?`,
    [companyId]
  );

  return company || null;
}

function mapUserForResponse(user) {
  if (!user) return null;

  return {
    id: user.member_id || user.id,
    company_id: user.company_id || null,
    name: user.name,
    email: user.email,
    role: normalizeRole(user.role),
    status: user.status || "ACTIVE",
    must_change_password: Boolean(user.must_change_password),
    salutation: user.salutation,
    dob: user.dob,
    designation: user.designation,
    mobile: user.mobile,
    profile_picture: user.profile_picture,
    auth_provider: user.auth_provider,
    email_verified_at: user.email_verified_at,
    is_platform_admin: Boolean(user.is_platform_admin),
    permissions: cleanPermissionList(user.permissions || []),
    sub_plan: user.sub_plan || user.subscription_plan || "TRIAL",
    sub_status: user.sub_status || user.subscription_status || "ACTIVE",
    trial_ends_at: user.trial_ends_at,
    sub_ends_at: user.sub_ends_at || user.subscription_ends_at,
    created_at: user.created_at,
  };
}

async function loadAuthContext(executor, userId) {
  const user = await loadTenantUser(executor, userId);
  if (!user) {
    return { user: null, company: null };
  }

  const company = await loadCompanyProfile(executor, user.company_id);
  return {
    user: mapUserForResponse(user),
    company,
  };
}

module.exports = {
  ALL_PERMISSION_KEYS,
  LEGACY_PERMISSION_EXPANSIONS,
  MODULE_ACTIONS,
  PERMISSION_DEFINITIONS,
  buildModulePermissions,
  cleanPermissionList,
  expandPermissionKeys,
  getDefaultPermissionsForRole,
  getEffectivePermissions,
  hasPermission,
  loadAuthContext,
  loadCompanyProfile,
  loadTenantUser,
  mapUserForResponse,
  normalizeRole,
  syncPermissionCatalog,
};
