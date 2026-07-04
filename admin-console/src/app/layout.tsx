import type { Metadata } from "next";
import Link from "next/link";
import { Outfit } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "E-GAOP | Enterprise-Grade Agent Orchestration Platform",
  description: "Kubernetes for AI Agents - Production-grade orchestration, security, and observability.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${outfit.variable} font-sans bg-bg-base text-text-primary`}>
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 pl-64 min-h-screen flex flex-col">
              <Header />
              <div className="p-8 pb-20">{children}</div>
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
