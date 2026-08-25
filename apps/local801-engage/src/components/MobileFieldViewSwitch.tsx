"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const MOBILE_FIELD_QUERY = "(max-width: 720px)";
const VIEW_PREFERENCE_KEY = "local801:outreach-view:v1";

type ViewPreference = "field" | "standard";

function readViewPreference(): ViewPreference | null {
  try {
    const value = window.sessionStorage.getItem(VIEW_PREFERENCE_KEY);
    return value === "field" || value === "standard" ? value : null;
  } catch {
    return null;
  }
}

function writeViewPreference(value: ViewPreference) {
  try {
    window.sessionStorage.setItem(VIEW_PREFERENCE_KEY, value);
  } catch {
    // The explicit standard-view URL still preserves the opt-out when storage is unavailable.
  }
}

export function MobileFieldViewSwitch({
  allowAutomaticMobileDefault,
  fieldHref,
  fieldMode,
  standardHref,
}: {
  allowAutomaticMobileDefault: boolean;
  fieldHref: string;
  fieldMode: boolean;
  standardHref: string;
}) {
  const router = useRouter();
  const redirectStarted = useRef(false);

  useEffect(() => {
    if (fieldMode || !allowAutomaticMobileDefault || redirectStarted.current) return;
    if (!window.matchMedia(MOBILE_FIELD_QUERY).matches) return;
    if (readViewPreference() === "standard") return;

    redirectStarted.current = true;
    router.replace(fieldHref, { scroll: false });
  }, [allowAutomaticMobileDefault, fieldHref, fieldMode, router]);

  if (fieldMode) {
    return <Link
      className="button secondary outreach-header-action outreach-exit-field-action"
      href={standardHref}
      onClick={() => writeViewPreference("standard")}
    >Use standard view</Link>;
  }

  return <Link
    className="button outreach-header-action outreach-start-field-action"
    href={fieldHref}
    onClick={() => writeViewPreference("field")}
  >Start field view</Link>;
}
