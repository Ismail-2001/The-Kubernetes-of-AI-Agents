import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "E-GAOP | Enterprise-Grade Agent Orchestration Platform",
  description: "Kubernetes for AI Agents - Production-grade orchestration, security, and observability.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${outfit.variable} font-sans bg-bg-base text-text-primary`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
