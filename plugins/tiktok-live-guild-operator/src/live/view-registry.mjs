import { GuildError } from "../errors.mjs";

const API = "/creators/live/union_platform_api";
const view = (domain, child, route, responsePaths = [], prepare = undefined) => Object.freeze({
  domain,
  child,
  route,
  response_paths: Object.freeze(responsePaths),
  prepare
});

async function openAffiliateAccounts(page) {
  const tab = page.getByText("Affiliate Accounts", { exact: true });
  await tab.waitFor({ timeout: 12_000 });
  const policyDialog = page.getByRole("dialog").filter({ hasText: "TikTok Creator Network Management Policy" });
  const close = policyDialog.getByRole("button", { name: "close" });
  if (await close.isVisible()) await close.click();
  await tab.click();
}

const VIEWS = Object.freeze([
  view("guild_creators", "list_creators", "/portal/anchor/list", [
    `${API}/agency/manage_host/get_managed_host_amount/`,
    `${API}/agency/manage_host/get_managed_host_list/`
  ]),
  view("guild_creators", "list_relationships", "/portal/anchor/relation", [
    `${API}/anchor/invite_list/`,
    `${API}/anchor/follow_up/list/`
  ]),
  view("guild_creators", "list_live_activity", "/portal/anchor/live", [
    `${API}/union/anchor/live/live_room_list/`,
    `${API}/union/anchor/live/batch_get_live_room_extra_info/`
  ]),
  view("guild_creators", "list_follow_up", "/portal/anchor/abnormal", [
    `${API}/union/anchor/get_abnormal_host_list/`
  ]),
  view("guild_creators", "list_creator_violations", "/portal/anchor/violation", [
    `${API}/agency/contentViolation/getViolationHistory/`
  ]),

  view("guild_recruitment", "list_prospects", "/portal/anchor/scout-creators", [
    `${API}/agency/host_recruitment/lead/get_leads_v2/`,
    `${API}/agency/host_recruitment/lead/get_stage_count_v2/`
  ]),
  view("guild_recruitment", "list_affiliate_accounts", "/portal/anchor/scout-creators?tab=accounts", [
    `${API}/agency/host_recruitment/tt_biz_account/employee/accounts/`
  ], openAffiliateAccounts),
  view("guild_recruitment", "list_recommendations", "/portal/anchor/scout-creators", [
    `${API}/agency/host_recruitment/recommendation/get_recommendation_info/`
  ]),
  view("guild_recruitment", "list_invitations", "/portal/anchor/invitation-management", [
    `${API}/agency/quota/get_invitation_stat_list/`
  ]),
  view("guild_recruitment", "get_invitation_quota", "/portal/anchor/invitation-management", [
    `${API}/agency/quota/get_approval_pending_amount/`,
    `${API}/agency/quota/get_invitation_overview/`
  ]),

  view("guild_messaging", "list_conversations", "/portal/anchor/instant-messages"),
  view("guild_messaging", "get_messages", "/portal/anchor/instant-messages"),

  view("guild_operations", "list_activities", "/portal/tools/activity", [
    `${API}/agency/activity_pack/ranklist/square/`,
    `${API}/agency/activity_pack/template/valid_template/`
  ]),
  view("guild_operations", "get_flare_card_quota", "/portal/tools/flare-card", [
    `${API}/agency/boost/flare_card/v2/agency_basic_info/`
  ]),
  view("guild_operations", "list_flare_card_records", "/portal/tools/flare-card", [
    `${API}/agency/boost/flare_card/v2/get_send_record_list/`
  ]),
  view("guild_operations", "get_promote_authorization", "/portal/tools/promote", [
    `${API}/agency/boost/promote/get_auth_agent_list/`,
    `${API}/agency/boost/promote/get_open_region_list/`
  ]),
  view("guild_operations", "list_promote_coupons", "/portal/tools/promote", [
    `${API}/agency/boost/promote/get_coupon_batch/`
  ]),

  view("guild_revenue", "get_overview", "/portal/overview", [
    `${API}/agency/workbench/core_metrics/v2/`,
    `${API}/agency/workbench/task_detail/`
  ]),
  view("guild_revenue", "list_incentive_tasks", "/portal/revenue/task", [
    `${API}/agency/task/get_agency_overview/`,
    `${API}/agency/task/get_agent_settle_detail_v2/`,
    `${API}/agency/task/get_monthly_chart/`,
    `${API}/agency/task/get_task_settle_detail_list/`
  ]),
  view("guild_revenue", "list_contributions", "/portal/revenue/task", [
    `${API}/agency/task/get_anchor_settle_detail_v2/`
  ]),
  view("guild_revenue", "get_business_evaluation", "/portal/revenue/business-essentials", [
    `${API}/agency/agency_management_strategy/overview/v2/get/`,
    `${API}/agency/agency_management_strategy/record/get/`
  ]),

  view("guild_governance", "list_guild_violations", "/portal/punishment/violation-center", [
    `${API}/agency/violation_center/summary_overview/get/`,
    `${API}/agency/violation_center/violation_detail/list/get/`
  ]),
  view("guild_governance", "list_health_events", "/portal/punishment/health-score", [
    `${API}/agency/govern/healthScore/GetHealthScoreRecord/`,
    `${API}/agency/govern/healthScore/GetHealthScoreRecoveryTaskStatus/`
  ]),
  view("guild_governance", "list_reports", "/portal/punishment/reports", [
    `${API}/agency/report/m_get_report_for_backstage/`
  ]),
  view("guild_governance", "list_appeals", "/portal/punishment/publicNotice", [
    `${API}/agency/report/m_get_user_appeal/`
  ]),
  view("guild_governance", "list_organization", "/portal/administration/staff", [
    `${API}/agency/group_management/get_agency_members/`,
    `${API}/agency/group_management/group_detail/`
  ]),
  view("guild_governance", "list_permissions", "/portal/administration/permission", [
    `${API}/agency/user_permission/list/`
  ]),

  view("guild_intelligence", "list_recruitment_metrics", "/portal/data/new-anchor-analysis", [
    `${API}/union/anchor/get_new_anchor_scale/`,
    `${API}/union/anchor/get_new_anchor_performance/`,
    `${API}/union/anchor/get_new_anchor_datail_data/`
  ]),
  view("guild_intelligence", "list_creator_metrics", "/portal/data/data", [
    `${API}/union/anchor/get_anchor_data/`
  ]),
  view("guild_intelligence", "list_team_metrics", "/portal/data/performance", [
    `${API}/union/team_performance/get_data_v2/`,
    `${API}/union/team_performance/get_list_v2/`
  ]),
  view("guild_intelligence", "list_guild_metrics", "/portal/data/agencyAnalysis", [
    `${API}/agency/agency_analysis/get_analysis/`
  ]),
  view("guild_intelligence", "list_live_reports", "/portal/data/report", [
    `${API}/union/report/get_weekly_report_data/`,
    `${API}/union/report/get_weekly_report_valid_week/`
  ])
]);

const BY_KEY = new Map(VIEWS.map((entry) => [`${entry.domain}:${entry.child}`, entry]));

export function getView(domain, child) {
  const result = BY_KEY.get(`${domain}:${child}`);
  if (!result) throw new GuildError("capability_unavailable", "The requested live view is not registered.");
  return result;
}

export function listViews() {
  return VIEWS;
}
