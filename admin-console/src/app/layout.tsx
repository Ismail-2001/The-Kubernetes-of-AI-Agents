import type { Metadata } from "next";
import Link from "next/link";
import { Outfit } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import {
  Cpu,
  ShieldCheck,
  Activity,
  Settings,
  LayoutDashboard,
} from "lucide-react";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

export const metadata: Metadata = {
  title: "E-GAOP | Enterprise-Grade Agent Orchestration Platform",
  description: "Kubernetes for AI Agents - Production-grade orchestration, security, and observability.",
};

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard" },
  { icon: Cpu, label: "Agent Registry", href: "/agents" },
  { icon: Activity, label: "Observability", href: "/observability" },
  { icon: Settings, label: "Settings", href: "/settings" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${outfit.variable} font-sans bg-bg-base text-text-primary`}>
        <Providers>
        <div className="flex min-h-screen">
          {/* Sidebar */}
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

            <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
              {navItems.map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  className={`
                    group flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200
                    hover:bg-white/5 hover:translate-x-1
                    ${item.label === "Dashboard" ? "bg-brand-primary/10 text-brand-primary border border-brand-primary/20 shadow-lg shadow-brand-primary/10" : "text-text-secondary hover:text-text-primary"}
                  `}
                >
                  <item.icon className="w-5 h-5 transition-transform group-hover:scale-110" />
                  <span className="font-semibold text-sm">{item.label}</span>
                </Link>
              ))}
            </nav>

            <div className="p-4 mt-auto">
              <div className="p-4 rounded-2xl bg-gradient-to-tr from-brand-primary/20 to-brand-secondary/20 border border-brand-primary/20">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                  <p className="text-[10px] font-bold text-text-primary uppercase tracking-widest">
                    Platform Status
                  </p>
                </div>
                <p className="text-xs text-text-secondary">
                  Control Plane: <span className="text-success font-semibold">Online</span>
                </p>
                <div className="mt-3 w-full bg-white/5 h-1 rounded-full overflow-hidden">
                  <div className="w-[85%] h-full bg-brand-primary animate-pulse" />
                </div>
              </div>
            </div>
          </aside>

          {/* Main Content Area */}
          <main className="flex-1 pl-64 min-h-screen flex flex-col">
            <header className="h-20 flex items-center justify-between px-8 border-b border-white/5 bg-bg-base/50 backdrop-blur-md sticky top-0 z-40">
              <div className="flex items-center gap-4">
                <span className="px-3 py-1 bg-white/5 border border-white/10 rounded-full text-[10px] font-bold tracking-widest uppercase text-text-muted">
                  Tenant-Acme / Production
                </span>
              </div>
              <div className="flex items-center gap-4">
                <button className="p-2 rounded-lg hover:bg-white/5 transition-colors text-text-secondary">
                  <Activity className="w-5 h-5" />
                </button>
                <div className="w-px h-6 bg-white/10 mx-2" />
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="text-xs font-bold text-text-primary">Jane Doe</p>
                    <p className="text-[10px] text-text-secondary">Platform Admin</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-secondary/20 to-accent/20 border border-white/10 flex items-center justify-center p-2 overflow-hidden">
                     {/* Replace with actual user image if available */}
                     <span className="text-sm font-bold text-brand-primary">JD</span>
                  </div>
                </div>
              </div>
            </header>
            
            <div className="p-8 pb-20">
              {children}
            </div>
          </main>
        </div>
        </Providers>
      </body>
    </html>
  );
}
