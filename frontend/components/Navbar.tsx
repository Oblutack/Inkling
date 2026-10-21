"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "../contexts/AuthContext";
import BrandMark from "./BrandMark";
import { useT } from "./I18nProvider";
import LanguageSwitcher from "./LanguageSwitcher";
import ThemeToggle from "./ThemeToggle";

const linkClass = "rounded-md px-3 py-2 text-[15px] font-medium text-ink/80 hover:bg-ink/10 hover:text-ink aria-[current=page]:bg-ink/10 aria-[current=page]:text-ink";

export default function Navbar() {
  const { user, logout, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const [open, setOpen] = useState(false);

  // Going somewhere closes the phone menu; so does Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  const link = (href: string, label: string, extra = "") => (
    <Link href={href} className={`${linkClass} ${extra}`} aria-current={pathname === href ? "page" : undefined}>
      {label}
    </Link>
  );

  // The links depend on who is signed in, which is not known for a moment: show none rather than the wrong ones.
  const links = loading ? null : user ? (
    <>
      {link("/dashboard", t("nav.dashboard"))}
      {link("/reading", t("nav.reading"))}
      {link("/exam", t("nav.exam"))}
      {link("/watches", t("nav.watches"))}
      {link("/account", t("nav.account"))}
      <button onClick={handleLogout} className={`${linkClass} text-left`}>
        {t("nav.logout")}
      </button>
    </>
  ) : (
    <>
      {link("/login", t("nav.login"))}
      <Link href="/signup" className="btn btn-primary btn-sm" aria-current={pathname === "/signup" ? "page" : undefined}>
        {t("nav.signup")}
      </Link>
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-ink/15 bg-canvas/90 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5" aria-label="Main">
        <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2.5" aria-label={t("nav.home")}>
          <BrandMark />
          <span className="font-display text-2xl tracking-[0.2em]">Inkling</span>
        </Link>

        <div className="hidden items-center gap-1 lg:flex">
          {links}
          <span className="mx-1 h-6 w-px bg-ink/20" aria-hidden="true" />
          <ThemeToggle />
          <LanguageSwitcher />
        </div>

        <button
          type="button"
          className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-ink/10 lg:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? t("nav.closeMenu") : t("nav.menu")}
          onClick={() => setOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="panel-in border-t border-ink/15 px-4 pb-4 pt-2 lg:hidden">
          <div className="flex flex-col gap-1 [&>*]:py-3">{links}</div>
          <div className="mt-2 flex items-center gap-2 border-t border-ink/15 pt-3">
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </div>
      )}
    </header>
  );
}
