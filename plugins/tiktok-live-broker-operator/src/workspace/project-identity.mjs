import { GuildError } from "../errors.mjs";

const COUNTRY = /^[A-Z]{2}$/u;
const REGION = /^[A-Z][A-Z0-9_-]{1,31}$/u;

function mismatch() {
  return new GuildError("adapter_mismatch", "The Backstage startup identity response changed shape.");
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw mismatch();
  return value;
}

function text(value, maximum = 1_024) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum) {
    throw mismatch();
  }
  return value.trim().normalize("NFC");
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw mismatch();
  return value;
}

export function projectIdentity(body) {
  const root = record(body);
  const union = record(root.union);
  const user = record(root.user);
  if (union.id === "" && union.name === ""
    && user.unionID === "" && user.unionName === ""
    && Array.isArray(root.roles) && root.roles.length === 0) {
    throw new GuildError("login_required", "TikTok LIVE Backstage login is required.");
  }
  const guildId = text(union.id);
  const guildName = text(union.name);
  if (text(user.unionID) !== guildId || text(user.unionName) !== guildName) throw mismatch();
  if (!COUNTRY.test(union.country) || !REGION.test(union.region)) throw mismatch();
  if (!Array.isArray(root.roles) || root.roles.length < 1 || root.roles.length > 32) throw mismatch();

  const roles = root.roles.map((rawRole) => {
    const role = record(rawRole);
    if (text(role.unionID) !== guildId) throw mismatch();
    return Object.freeze({
      id: text(role.id, 256),
      name: text(role.name, 256),
      orgID: text(role.orgID, 256),
      roleLevel: integer(role.roleLevel),
      roleStatus: integer(role.roleStatus),
      roleType: integer(role.roleType),
      roleTypeName: text(role.roleTypeName, 256),
      unionID: guildId
    });
  });

  return Object.freeze({
    guild_id: guildId,
    guild_name: guildName,
    registered_country: union.country,
    portal_region: union.region,
    account_role: integer(user.roleType),
    roles: Object.freeze(roles)
  });
}
