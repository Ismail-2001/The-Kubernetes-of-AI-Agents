import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import { ShieldCheck } from "lucide-react";
import "../globals.css";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "E-GAOP | Sign In",
  description: "Sign in to your E-GAOP account",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${outfit.variable} font-sans bg-bg-base text-text-primary min-h-screen flex items-center justify-center`}>
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-primary/10 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-brand-secondary/10 rounded-full blur-3xl" />
        </div>
        <div className="relative z-10 w-full max-w-md px-6">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-brand-primary to-brand-secondary flex items-center justify-center shadow-premium">
                <ShieldCheck className="w-7 h-7 text-white" />
              </div>
              <div className="text-left">
                <h1 className="text-2xl font-bold tracking-tight">E-GAOP</h1>
                <p className="text-[10px] text-brand-primary font-bold uppercase tracking-widest">
                  Agent Orchestration
                </p>
              </div>
            </div>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
