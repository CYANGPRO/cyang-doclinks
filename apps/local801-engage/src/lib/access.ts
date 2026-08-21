export const roleLabels = {
  system_owner: "System Owner",
  local_admin: "Local Administrator",
  membership_data_manager: "Membership Data Manager",
  cat_admin: "CAT Administrator",
  cat_lead: "CAT Lead",
  cat_member: "CAT Member",
  report_viewer: "Report Viewer",
} as const;

export type Role = keyof typeof roleLabels;

export const permissions = {
  manageUsers: ["system_owner", "local_admin"],
  manageImports: ["system_owner", "local_admin", "membership_data_manager"],
  approveImports: ["system_owner", "local_admin", "membership_data_manager"],
  manageCampaigns: ["system_owner", "local_admin", "cat_admin"],
  manageCatActions: ["system_owner", "local_admin", "cat_admin"],
  manageDocuments: ["system_owner", "local_admin", "membership_data_manager", "cat_admin"],
  viewDocuments: ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "cat_member"],
  viewLocalAdminDocuments: ["system_owner", "local_admin"],
  viewCatMemberDocuments: ["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"],
  generateReports: ["system_owner", "local_admin", "membership_data_manager", "cat_admin"],
  viewPersonLevelReports: ["system_owner", "local_admin", "membership_data_manager"],
  viewReports: ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"],
  viewDirectory: ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "cat_member"],
  viewTeamScope: ["system_owner", "local_admin", "cat_admin", "cat_lead"],
  recordEngagement: ["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"],
  exportRoster: ["system_owner", "local_admin", "membership_data_manager"],
  viewRestrictedStrategy: ["system_owner", "local_admin", "cat_admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof permissions;

export function can(role: Role, permission: Permission) {
  return (permissions[permission] as readonly Role[]).includes(role);
}

export type NavigationGroup = "Overview" | "Members" | "Organizing" | "Information" | "Administration";

export type NavigationItem = {
  href: string;
  label: string;
  group: NavigationGroup;
  permission?: Permission;
  mobilePriority?: readonly Role[];
};

const navigationItems: readonly NavigationItem[] = [
  { href: "/", label: "Home", group: "Overview", mobilePriority: Object.keys(roleLabels) as Role[] },
  { href: "/membership", label: "Membership", group: "Members", permission: "manageImports", mobilePriority: ["system_owner", "local_admin", "membership_data_manager"] },
  { href: "/directory", label: "Directory", group: "Members", permission: "viewDirectory", mobilePriority: ["cat_admin", "cat_lead", "cat_member"] },
  { href: "/new-hires", label: "New Hires", group: "Members", permission: "manageImports" },
  { href: "/imports", label: "Data Imports", group: "Members", permission: "manageImports", mobilePriority: ["system_owner", "local_admin", "membership_data_manager"] },
  { href: "/outreach", label: "My Outreach", group: "Organizing", permission: "recordEngagement", mobilePriority: ["cat_admin", "cat_lead", "cat_member"] },
  { href: "/follow-ups", label: "Follow-ups", group: "Organizing", permission: "recordEngagement", mobilePriority: ["cat_admin", "cat_lead", "cat_member"] },
  { href: "/campaigns", label: "Campaigns", group: "Organizing", permission: "manageCampaigns", mobilePriority: ["cat_admin"] },
  { href: "/cat-actions", label: "CAT Actions", group: "Organizing", permission: "manageCatActions" },
  { href: "/documents", label: "Documents", group: "Information", permission: "viewDocuments" },
  { href: "/reports", label: "Reports", group: "Information", permission: "viewReports", mobilePriority: ["report_viewer"] },
  { href: "/audit", label: "Audit Activity", group: "Administration", permission: "manageUsers" },
  { href: "/team", label: "Team & Access", group: "Administration", permission: "manageUsers" },
  { href: "/settings", label: "Settings", group: "Administration", permission: "manageUsers" },
  { href: "/install", label: "Install App", group: "Administration" },
];

export function navForRole(role: Role) {
  return navigationItems
    .filter((item) => !item.permission || can(role, item.permission))
    .map(({ href, label, group }) => ({ href, label, group }));
}

export function navGroupsForRole(role: Role) {
  const items = navForRole(role);
  return (["Overview", "Members", "Organizing", "Information", "Administration"] as const)
    .map((label) => ({ label, items: items.filter((item) => item.group === label) }))
    .filter((group) => group.items.length > 0);
}

export function mobileNavForRole(role: Role) {
  const allowed = new Set(navForRole(role).map((item) => item.href));
  return navigationItems
    .filter((item) => allowed.has(item.href) && item.mobilePriority?.includes(role))
    .slice(0, 4)
    .map(({ href, label }) => ({ href, label }));
}

export function dashboardForRole(role: Role) {
  return {
    membership: can(role, "manageImports"),
    organizing: can(role, "recordEngagement"),
    campaigns: can(role, "manageCampaigns"),
    catActions: can(role, "manageCatActions"),
    reports: can(role, "viewReports"),
  };
}

export function shellForRole(role: Role | null) {
  return role
    ? { navigation: navForRole(role), roleLabel: roleLabels[role] }
    : { navigation: [], roleLabel: null };
}
