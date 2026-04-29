const ALL_PERMISSION_KEYS = [
  "can_view_dashboard",
  "can_manage_products",
  "can_manage_inventory",
  "can_manage_customers",
  "can_manage_vendors",
  "can_manage_invoices",
  "can_manage_bills",
  "can_view_reports",
  "can_manage_company",
  "can_manage_users",
];

const PERMISSION_DEFINITIONS = [
  { key: "can_view_dashboard", label: "View dashboard", module: "dashboard" },
  { key: "can_manage_products", label: "Manage products", module: "products" },
  { key: "can_manage_inventory", label: "Manage inventory", module: "inventory" },
  { key: "can_manage_customers", label: "Manage customers", module: "customers" },
  { key: "can_manage_vendors", label: "Manage vendors", module: "vendors" },
  { key: "can_manage_invoices", label: "Manage invoices", module: "invoices" },
  { key: "can_manage_bills", label: "Manage bills", module: "bills" },
  { key: "can_view_reports", label: "View reports", module: "reports" },
  { key: "can_manage_company", label: "Manage company", module: "company" },
  { key: "can_manage_users", label: "Manage users", module: "users" },
];

const ROLE_DEFAULT_PERMISSIONS = {
  MASTER: ALL_PERMISSION_KEYS,
  ADMIN: [
    "can_view_dashboard",
    "can_manage_products",
    "can_manage_inventory",
    "can_manage_customers",
    "can_manage_vendors",
    "can_manage_invoices",
    "can_manage_bills",
    "can_view_reports",
  ],
  NORMAL: [],
};

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

function cleanPermissionList(values = []) {
  return [...new Set((values || []).filter((value) => ALL_PERMISSION_KEYS.includes(value)))].sort();
}

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
    permissions: user.permissions || [],
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
  PERMISSION_DEFINITIONS,
  cleanPermissionList,
  getDefaultPermissionsForRole,
  getEffectivePermissions,
  loadAuthContext,
  loadCompanyProfile,
  loadTenantUser,
  mapUserForResponse,
  normalizeRole,
};
