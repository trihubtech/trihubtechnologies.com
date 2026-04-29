const PLAN_PRICES = {
  MONTHLY: Number(process.env.SUBSCRIPTION_MONTHLY_PRICE || 499),
  YEARLY: Number(process.env.SUBSCRIPTION_YEARLY_PRICE || 4999),
};

function getPlanAmount(plan) {
  return PLAN_PRICES[plan] ?? null;
}

function getSubscriptionEndDate(plan, baseDate = new Date()) {
  const endDate = new Date(baseDate);

  if (plan === "MONTHLY") {
    endDate.setMonth(endDate.getMonth() + 1);
    return endDate;
  }

  if (plan === "YEARLY") {
    endDate.setFullYear(endDate.getFullYear() + 1);
    return endDate;
  }

  if (plan === "TRIAL") {
    endDate.setDate(endDate.getDate() + 7);
    return endDate;
  }

  return null;
}

async function loadCompanySubscription(executor, companyId) {
  const [[company]] = await executor.execute(
    `SELECT id, owner_user_id, subscription_plan, subscription_status, trial_ends_at, subscription_ends_at
     FROM companies
     WHERE id = ?`,
    [companyId]
  );

  return company || null;
}

async function insertSubscriptionLog(executor, {
  companyId,
  userId = null,
  changedBy = null,
  action,
  plan,
  notes = null,
}) {
  const company = await loadCompanySubscription(executor, companyId);
  const ownerUserId = userId || company?.owner_user_id || null;

  await executor.execute(
    `INSERT INTO subscription_logs (company_id, user_id, changed_by, action, plan, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [companyId, ownerUserId, changedBy, action, plan, notes]
  );
}

async function syncSubscriptionStatus(executor, companyLike) {
  if (!companyLike) {
    return false;
  }

  const companyId = companyLike.company_id || companyLike.id;
  const subStatus = companyLike.sub_status || companyLike.subscription_status;
  const subPlan = companyLike.sub_plan || companyLike.subscription_plan;
  const subEndsAt = companyLike.sub_ends_at || companyLike.subscription_ends_at;

  if (!companyId || subStatus === "EXPIRED" || !subEndsAt) {
    return false;
  }

  const endsAt = new Date(subEndsAt);
  if (Number.isNaN(endsAt.getTime()) || endsAt >= new Date()) {
    return false;
  }

  await executor.execute(
    "UPDATE companies SET subscription_status = 'EXPIRED' WHERE id = ?",
    [companyId]
  );


  await executor.execute(
    `UPDATE users SET status = 'DISABLED'
     WHERE company_id = ? AND is_platform_admin = 0 AND status = 'ACTIVE'`,
    [companyId]
  );

  await insertSubscriptionLog(executor, {
    companyId,
    action: "EXPIRED",
    plan: subPlan,
    notes:
      subPlan === "TRIAL"
        ? "Trial ended automatically. The workspace owner and all team members have been deactivated."
        : "Subscription expired automatically after the billing period ended. The workspace owner and all team members have been deactivated.",
  });

  if (companyLike.sub_status) {
    companyLike.sub_status = "EXPIRED";
  }
  if (companyLike.subscription_status) {
    companyLike.subscription_status = "EXPIRED";
  }

  return true;
}

async function activateSubscription(executor, {
  companyId,
  plan,
  changedBy = null,
  notes = null,
  baseDate = new Date(),
}) {
  const company = await loadCompanySubscription(executor, companyId);

  if (!company) {
    const error = new Error("Company not found");
    error.status = 404;
    throw error;
  }

  const action = company.subscription_status === "EXPIRED" ? "REACTIVATED" : "ACTIVATED";
  const subEndsAt = getSubscriptionEndDate(plan, baseDate);

  await executor.execute(
    `UPDATE companies
     SET subscription_plan = ?, subscription_status = 'ACTIVE', subscription_ends_at = ?
     WHERE id = ?`,
    [plan, subEndsAt, companyId]
  );

  await executor.execute(
    `UPDATE users SET status = 'ACTIVE'
     WHERE company_id = ? AND status = 'DISABLED' AND is_platform_admin = 0`,
    [companyId]
  );

  await insertSubscriptionLog(executor, {
    companyId,
    userId: company.owner_user_id,
    changedBy,
    action,
    plan,
    notes,
  });

  return { action, subEndsAt };
}

async function suspendSubscription(executor, {
  companyId,
  changedBy = null,
  notes = null,
}) {
  const company = await loadCompanySubscription(executor, companyId);

  if (!company) {
    const error = new Error("Company not found");
    error.status = 404;
    throw error;
  }

  await executor.execute(
    "UPDATE companies SET subscription_status = 'EXPIRED' WHERE id = ?",
    [companyId]
  );

  
  await executor.execute(
    `UPDATE users SET status = 'DISABLED'
     WHERE company_id = ? AND is_platform_admin = 0 AND status = 'ACTIVE'`,
    [companyId]
  );

  await insertSubscriptionLog(executor, {
    companyId,
    userId: company.owner_user_id,
    changedBy,
    action: "SUSPENDED",
    plan: company.subscription_plan,
    notes,
  });
}

module.exports = {
  PLAN_PRICES,
  activateSubscription,
  getPlanAmount,
  getSubscriptionEndDate,
  insertSubscriptionLog,
  suspendSubscription,
  syncSubscriptionStatus,
};
