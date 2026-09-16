"use client";

import { Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 pl-64 min-h-screen flex flex-col">
        <Header />
        <div className="p-8 pb-20">{children}</div>
      </main>
    </div>
  );
}
