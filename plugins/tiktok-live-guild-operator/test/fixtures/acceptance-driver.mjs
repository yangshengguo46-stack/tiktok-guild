import { GuildError } from "../../src/errors.mjs";

export function createAcceptanceComposition() {
  const page = { async close() {} };
  let launches = 0;
  let discoveries = 0;
  const sessionOwner = {
    getStatus() {
      return { state: launches === 0 ? "stopped" : "running", visible: launches > 0, launch_count: launches };
    },
    async ensureActive() {
      launches += launches === 0 ? 1 : 0;
      return { pages: () => [page], newPage: async () => ({ async close() {} }) };
    },
    async close() {}
  };
  const guildDiscovery = async () => {
    discoveries += 1;
    if (discoveries === 1) throw new GuildError("login_required", "Login is required.");
    return {
      guild_id: "103785",
      guild_name: "Atlantis",
      registered_country: "AE",
      portal_region: "MENA",
      account_role: 4,
      roles: []
    };
  };
  const liveReader = async ({ domain, child }) => {
    if (domain === "guild_governance") throw new GuildError("adapter_mismatch", "Governance fixture changed.");
    if (domain === "guild_recruitment" && child === "list_affiliate_accounts") {
      return {
        data: { responses: [{
          endpoint_path: "/creators/live/union_platform_api/agency/host_recruitment/tt_biz_account/employee/accounts/",
          body: {
            BaseResp: { StatusCode: 0, StatusMessage: "success" },
            EmployeeAccounts: [{ TTAccountID: "7654321", StoreRegion: "ae", AgentInfo: null }],
            HostBaseInfoMap: { "7654321": { display_id: "mira.creator_01", nickname: "Mira" } },
            Total: "1"
          }
        }] },
        evidence: [{ route: "/portal/anchor/scout-creators?tab=accounts", observed_at: "2026-09-25T00:00:00.000Z" }],
        completeness: { state: "complete", missing: [] },
        pagination: null
      };
    }
    const data = domain === "guild_creators"
      ? { creators: [{ creator_id: "738001", diamonds: 120034 }] }
      : { overview: { diamonds: 880001 } };
    return {
      data,
      evidence: [{ route: `/fixture/${domain}/${child}`, observed_at: "2026-09-20T00:00:00.000Z" }],
      completeness: { state: "complete", missing: [] },
      pagination: null
    };
  };
  return Object.freeze({ sessionOwner, guildDiscovery, liveReader });
}
