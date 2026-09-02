export type MembershipGroup = "classification" | "department" | "location";

export const MEMBERSHIP_GROUP_STORAGE_KEY = "local801.membership.last-group.v1";

export const MEMBERSHIP_GROUPS: ReadonlyArray<{ key: MembershipGroup; label: string; header: string }> = [
  { key: "classification", label: "Classification", header: "Classification" },
  { key: "department", label: "Department", header: "Department" },
  { key: "location", label: "Office", header: "Office / work location" },
];

export function isMembershipGroup(value: unknown): value is MembershipGroup {
  return value === "classification" || value === "department" || value === "location";
}

export function membershipGroupFromSearch(value: string | string[] | undefined): MembershipGroup {
  const selected = Array.isArray(value) ? value[0] : value;
  return isMembershipGroup(selected) ? selected : "classification";
}
