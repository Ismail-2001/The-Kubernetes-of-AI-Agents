"use client";

import { Activity } from "lucide-react";

export default function Header() {
  return (
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
            <span className="text-sm font-bold text-brand-primary">JD</span>
          </div>
        </div>
      </div>
    </header>
  );
}
