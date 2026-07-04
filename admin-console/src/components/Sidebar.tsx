"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ShieldCheck,
  LayoutDashboard,
  Cpu,
  GitBranch,
  Activity,
  Shield,
  Layers,
  Users,
  ScrollText,
  Settings,
  Bell,
  User,
} from "lucide-react";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard" },
  { icon: Cpu, label: "Agents", href: "/agents" },
  { icon: GitBranch, label: "Workflows", href: "/workflows" },
  { icon: Activity, label: "Observability", href: "/observability" },
  { icon: Shield, label: "Policies", href: "/policies" },
  { icon: Layers, label: "Namespaces", href: "/namespaces" },
  { icon: Users, label: "Users & RBAC", href: "/users" },
  { icon: ScrollText, label: "Audit Log", href: "/audit" },
];

const bottomItems = [
  { icon: Bell, label: "Notifications", href: "/notifications" },
  { icon: User, label: "Profile", href: "/profile" },
  { icon: Settings, label: "Settings", href: "/settings" },
];

function NavItem({ item, isActive }: { item: { icon: typeof LayoutDashboard; label: string; href: string }; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      className={`group flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-200 hover:bg-white/5 hover:translate-x-1 text-sm ${
        isActive
          ? "bg-brand-primary/10 text-brand-primary border border-brand-primary/20 shadow-lg shadow-brand-primary/10"
          : "text-text-secondary hover:text-text-primary"
      }`}
    >
      <item.icon className="w-4 h-4 transition-transform group-hover:scale-110" />
      <span className="font-semibold">{item.label}</span>
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-white/5 bg-bg-surface/50 backdrop-blur-xl flex flex-col fixed h-full z-50 transition-all duration-300">
      <div className="p-6 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-primary to-brand-secondary flex items-center justify-center shadow-premium">
          <ShieldCheck className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/70">
            E-GAOP
          </h1>
          <p className="text-[10px] text-brand-primary font-bold uppercase tracking-widest leading-none">
            Core Platform
          </p>
        </div>
      </div>

      <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => (
          <NavItem key={item.href} item={item} isActive={pathname === item.href || pathname.startsWith(item.href + "/")} />
        ))}
      </nav>

      <div className="px-4 py-2 space-y-1 border-t border-white/5">
        {bottomItems.map((item) => (
          <NavItem key={item.href} item={item} isActive={pathname === item.href} />
        ))}
      </div>

      <div className="p-4 mt-auto">
        <div className="p-4 rounded-2xl bg-gradient-to-tr from-brand-primary/20 to-brand-secondary/20 border border-brand-primary/20">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <p className="text-[10px] font-bold text-text-primary uppercase tracking-widest">Platform Status</p>
          </div>
          <p className="text-xs text-text-secondary">
            Control Plane: <span className="text-success font-semibold">Online</span>
          </p>
        </div>
      </div>
    </aside>
  );
}
