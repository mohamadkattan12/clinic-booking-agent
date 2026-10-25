"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Chat" },
  { href: "/staff", label: "Staff" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b">
      <nav aria-label="Main" className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 px-4 py-3">
        <span className="me-4 font-semibold">Mithal Dental · Booking agent</span>
        {LINKS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
              pathname === href && "bg-muted font-medium text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
