"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) setSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="glass-card p-8 text-center space-y-4">
        <CheckCircle className="w-12 h-12 text-success mx-auto" />
        <h2 className="text-xl font-bold text-text-primary">Check your email</h2>
        <p className="text-sm text-text-secondary">
          If an account exists with <span className="text-text-primary font-semibold">{email}</span>,
          you&apos;ll receive a password reset link shortly.
        </p>
        <Link href="/login" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-primary hover:text-brand-primary/80 transition-colors pt-2">
          Back to Sign In
        </Link>
      </div>
    );
  }

  return (
    <div className="glass-card p-8 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-text-primary">Reset password</h2>
        <p className="text-sm text-text-secondary mt-1">Enter your email and we&apos;ll send a reset link</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@egaop.io"
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full btn-primary flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              Send Reset Link
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <p className="text-center text-xs text-text-muted">
        Remember your password?{" "}
        <Link href="/login" className="font-semibold text-brand-primary hover:text-brand-primary/80 transition-colors">
          Sign in
        </Link>
      </p>
    </div>
  );
}
