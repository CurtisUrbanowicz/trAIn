"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Sun, Calendar, TrendingUp, Play, MessageCircle } from "lucide-react";

const tabs = [
  { name: "Today", href: "/today", icon: Sun },
  { name: "Week", href: "/week", icon: Calendar },
  { name: "Season", href: "/season", icon: TrendingUp },
  { name: "Session", href: "/session", icon: Play },
  { name: "Coach", href: "/coach", icon: MessageCircle },
] as const;

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="shrink-0 border-t"
      style={{
        height: "calc(49px + env(safe-area-inset-bottom, 0px))",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        background: "var(--bg-base)",
        borderColor: "var(--border-default)",
      }}
    >
      <div className="flex h-[49px] items-center justify-around">
        {tabs.map(({ name, href, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className="flex flex-col items-center gap-0.5"
              style={{ color: active ? "var(--accent)" : "var(--text-muted)" }}
            >
              <Icon size={20} strokeWidth={1.75} />
              <span style={{ fontSize: "10px", fontWeight: 500 }}>{name}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
