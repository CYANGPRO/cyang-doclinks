import Link from "next/link";

const informationLinks = [
  { href: "/about", label: "About" },
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/legal/terms", label: "Terms & acceptable use" },
  { href: "/accessibility", label: "Accessibility" },
  { href: "/support", label: "Support" },
  { href: "/install", label: "Install app" },
] as const;

export function UtilityFooter({ signedIn }: { signedIn: boolean }) {
  return <footer className="utility-footer">
    <div className="utility-footer-inner">
      <div className="utility-footer-copy">
        <strong>Engaging Local 801</strong>
        <span>Private workspace for approved MAPE Local 801 work.</span>
      </div>
      <nav aria-label="Site information" className="utility-footer-nav">
        {informationLinks.map((item) => <Link href={item.href} key={item.href}>{item.label}</Link>)}
        <Link href={signedIn ? "/" : "/sign-in"}>{signedIn ? "Workspace home" : "Sign in"}</Link>
      </nav>
    </div>
  </footer>;
}
