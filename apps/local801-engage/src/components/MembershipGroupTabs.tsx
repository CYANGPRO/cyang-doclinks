"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isMembershipGroup, MEMBERSHIP_GROUPS, MEMBERSHIP_GROUP_STORAGE_KEY, type MembershipGroup } from "@/lib/membership-group-preference";

function rememberGroup(group: MembershipGroup) {
  try {
    window.localStorage.setItem(MEMBERSHIP_GROUP_STORAGE_KEY, group);
  } catch { /* The URL remains the functional fallback when storage is unavailable. */ }
}

export function MembershipGroupTabs({ selectedGroup, hasExplicitSelection }: { selectedGroup: MembershipGroup; hasExplicitSelection: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (hasExplicitSelection) {
      rememberGroup(selectedGroup);
      return;
    }

    try {
      const rememberedGroup = window.localStorage.getItem(MEMBERSHIP_GROUP_STORAGE_KEY);
      if (isMembershipGroup(rememberedGroup) && rememberedGroup !== selectedGroup) {
        router.replace(`/membership?group=${rememberedGroup}`);
      } else if (!isMembershipGroup(rememberedGroup)) {
        rememberGroup("classification");
      }
    } catch { /* Classification remains the safe default. */ }
  }, [hasExplicitSelection, router, selectedGroup]);

  return <nav className="membership-group-tabs" aria-label="Membership breakdown views">
    {MEMBERSHIP_GROUPS.map((item) => <Link
      key={item.key}
      href={`/membership?group=${item.key}`}
      aria-current={selectedGroup === item.key ? "page" : undefined}
      className={`${selectedGroup === item.key ? "button" : "button secondary"} membership-group-tab`}
      onClick={() => rememberGroup(item.key)}
    >
      {item.label}
    </Link>)}
  </nav>;
}
