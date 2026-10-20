const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BROAD_PERMISSIONS = new Set(["全部", "all", "*"]);
const PERSONA_REFS = new Set([
  "relaxed_wit@1.0.1",
  "clear_direct@1.0.1",
  "curious_explorer@1.0.1",
  "observant_warmth@1.0.1",
  "quiet_depth@1.0.1",
  "warm_candid@1.0.1"
]);
function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} is required.`);
  }
  return value.trim();
}

function safeId(value, field) {
  const normalized = requiredString(value, field);
  if (!ID_PATTERN.test(normalized)) throw new TypeError(`${field} is invalid.`);
  return normalized;
}

function normalizedEmail(value, field = "mailbox") {
  const email = requiredString(value, field).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new TypeError(`${field} is invalid.`);
  return email;
}

function approvedPersonaRef(value) {
  const ref = requiredString(value, "persona_ref");
  if (!PERSONA_REFS.has(ref)) throw new TypeError("persona_ref is not an approved expression asset.");
  return ref;
}

function homepageCandidate(username) {
  return `https://www.tiktok.com/@${username}`;
}

function safeAssignments(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new TypeError("assignments must be a non-empty array.");
  }
  const seen = new Set();
  return assignments.map((assignment, index) => {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
      throw new TypeError(`assignments[${index}] is invalid.`);
    }
    const email = normalizedEmail(assignment.email, `assignments[${index}].email`);
    if (seen.has(email)) throw new TypeError(`duplicate staff email: ${email}`);
    seen.add(email);
    const permissions = Array.isArray(assignment.permissions)
      ? assignment.permissions.map((permission) => requiredString(permission, "permission"))
      : [];
    if (permissions.some((permission) => BROAD_PERMISSIONS.has(permission))) {
      throw new TypeError("broad permission is not allowed.");
    }
    return {
      email,
      group: requiredString(assignment.group, `assignments[${index}].group`),
      role: requiredString(assignment.role, `assignments[${index}].role`),
      permissions
    };
  });
}

function safeAllocations(allocations) {
  if (allocations === undefined) return [];
  if (!Array.isArray(allocations)) throw new TypeError("allocations must be an array.");
  return allocations.map((allocation, index) => {
    if (!allocation || typeof allocation !== "object" || Array.isArray(allocation)) {
      throw new TypeError(`allocations[${index}] is invalid.`);
    }
    const target = requiredString(allocation.target, `allocations[${index}].target`);
    const regular = allocation.regular === undefined ? 0 : Number(allocation.regular);
    const premium = allocation.premium === undefined ? 0 : Number(allocation.premium);
    if (!Number.isInteger(regular) || regular < 0 || !Number.isInteger(premium) || premium < 0) {
      throw new TypeError(`allocations[${index}] quantities must be non-negative integers.`);
    }
    if (regular === 0 && premium === 0) throw new TypeError(`allocations[${index}] must allocate at least one card.`);
    return { target, regular, premium };
  });
}

export function prepareAffiliateAccountPlan({ guild, username, nickname, persona_ref, country, idempotency_key } = {}) {
  if (!guild || typeof guild !== "object" || Array.isArray(guild)) {
    throw new TypeError("guild identity is required.");
  }
  const normalizedUsername = requiredString(username, "username");
  if (!/^[A-Za-z0-9_.]{1,25}$/.test(normalizedUsername)
    || /^[A-Za-z]+$/.test(normalizedUsername)
    || normalizedUsername.endsWith(".")) {
    throw new TypeError("username does not satisfy Backstage affiliate-account rules.");
  }
  const normalizedNickname = requiredString(nickname, "nickname");
  if ([...normalizedNickname].length >= 30 || !/[\p{L}\p{N}]/u.test(normalizedNickname)) {
    throw new TypeError("nickname does not satisfy Backstage affiliate-account rules.");
  }
  const normalizedCountry = requiredString(country, "country").toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedCountry)) throw new TypeError("country must be a two-letter code.");
  return {
    kind: "affiliate_account_creation",
    status: "ready_for_agent",
    guild_ref: safeId(guild.guild_ref, "guild.guild_ref"),
    guild_id: safeId(guild.guild_id, "guild.guild_id"),
    username: normalizedUsername,
    nickname: normalizedNickname,
    persona_ref: approvedPersonaRef(persona_ref),
    tiktok_homepage_candidate: homepageCandidate(normalizedUsername),
    country: normalizedCountry,
    idempotency_key: safeId(idempotency_key, "idempotency_key"),
    required_approvals: [],
    capability: "write_verified"
  };
}

export function prepareAffiliateAssignmentPlan({ guild_ref, affiliate_account_id, broker_email, idempotency_key } = {}) {
  return {
    kind: "affiliate_account_assignment",
    status: "ready_for_agent",
    guild_ref: safeId(guild_ref, "guild_ref"),
    affiliate_account_id: safeId(affiliate_account_id, "affiliate_account_id"),
    broker_email: normalizedEmail(broker_email, "broker_email"),
    idempotency_key: safeId(idempotency_key, "idempotency_key"),
    required_approvals: [],
    capability: "write_verified"
  };
}

export function prepareBrokerProfilePlan({ guild_ref, broker_email, affiliate_username, broker_name, persona_ref, contact_email, idempotency_key } = {}) {
  const name = requiredString(broker_name, "broker_name");
  if ([...name].length < 3 || [...name].length > 60) throw new TypeError("broker_name must contain 3 to 60 characters.");
  const username = requiredString(affiliate_username, "affiliate_username");
  return {
    kind: "broker_profile_update",
    status: "ready_for_agent",
    guild_ref: safeId(guild_ref, "guild_ref"),
    broker_email: normalizedEmail(broker_email, "broker_email"),
    affiliate_username: username,
    broker_name: name,
    persona_ref: approvedPersonaRef(persona_ref),
    tiktok_homepage_candidate: homepageCandidate(username),
    contact_email: normalizedEmail(contact_email, "contact_email"),
    idempotency_key: safeId(idempotency_key, "idempotency_key"),
    required_approvals: [],
    capability: "write_verified"
  };
}

export function prepareAssignmentPlan({ guild_ref, assignments, idempotency_key } = {}) {
  return {
    kind: "staff_assignment",
    status: "ready_for_agent",
    guild_ref: safeId(guild_ref, "guild_ref"),
    assignments: safeAssignments(assignments),
    idempotency_key: safeId(idempotency_key, "idempotency_key"),
    required_approvals: [],
    capability: "write_verified"
  };
}

export function prepareAllocationPlan({ guild_ref, allocations, idempotency_key } = {}) {
  return {
    kind: "invitation_card_allocation",
    status: "ready_for_agent",
    guild_ref: safeId(guild_ref, "guild_ref"),
    allocations: safeAllocations(allocations),
    idempotency_key: safeId(idempotency_key, "idempotency_key"),
    required_approvals: [],
    capability: "write_verified"
  };
}
