"use client";

import { useState } from "react";
import {
  User,
  Mail,
  Key,
  Shield,
  Camera,
  Save,
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  Plus,
  Trash2,
} from "lucide-react";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsed: string;
  expiresAt?: string;
}

const mockKeys: ApiKey[] = [
  { id: "key-001", name: "Production API Key", prefix: "egaop_prod_", createdAt: "2025-01-15T00:00:00Z", lastUsed: new Date(Date.now() - 3600000).toISOString() },
  { id: "key-002", name: "CI/CD Pipeline", prefix: "egaop_ci_", createdAt: "2025-02-01T00:00:00Z", lastUsed: new Date(Date.now() - 86400000).toISOString(), expiresAt: "2026-02-01T00:00:00Z" },
];

export default function ProfilePage() {
  const [name, setName] = useState("Jane Doe");
  const [email, setEmail] = useState("jane@egaop.io");
  const [showApiKey, setShowApiKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 1000));
    setSaving(false);
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
      <div>
        <h1 className="text-3xl font-bold text-text-primary">Profile</h1>
        <p className="text-sm text-text-secondary mt-1">Manage your account settings and API keys</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <div className="glass-card p-6 space-y-6">
            <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <User className="w-5 h-5 text-brand-primary" />
              Personal Information
            </h3>

            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-brand-primary/20 to-brand-secondary/20 border border-white/10 flex items-center justify-center text-2xl font-bold text-brand-primary">
                JD
              </div>
              <button className="btn-secondary text-xs flex items-center gap-2">
                <Camera className="w-4 h-4" />
                Change Avatar
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">Full Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
                />
              </div>
            </div>

            <button onClick={handleSave} disabled={saving} className="btn-primary text-sm flex items-center gap-2">
              {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          </div>

          <div className="glass-card p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
                <Key className="w-5 h-5 text-brand-primary" />
                API Keys
              </h3>
              <button className="btn-primary text-xs flex items-center gap-2">
                <Plus className="w-3 h-3" />
                Generate Key
              </button>
            </div>

            <div className="space-y-3">
              {mockKeys.map((key) => (
                <div key={key.id} className="flex items-center justify-between p-4 bg-white/[0.02] border border-white/5 rounded-xl">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{key.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-xs text-text-muted font-mono">
                        {showApiKey === key.id ? `${key.prefix}sk-xxxxxxxxxxxxxxxxxxxx` : key.prefix + "••••••••"}
                      </code>
                      <button onClick={() => setShowApiKey(showApiKey === key.id ? null : key.id)} className="text-text-muted hover:text-text-secondary">
                        {showApiKey === key.id ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">Last used: {new Date(key.lastUsed).toLocaleDateString()}</span>
                    <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass-card p-6 space-y-4">
            <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <Shield className="w-5 h-5 text-brand-primary" />
              Security
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-white/[0.02] border border-white/5 rounded-xl">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Password</p>
                  <p className="text-xs text-text-muted">Last changed 45 days ago</p>
                </div>
                <button className="btn-secondary text-xs">Change</button>
              </div>
              <div className="flex items-center justify-between p-3 bg-white/[0.02] border border-white/5 rounded-xl">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Two-Factor Auth</p>
                  <p className="text-xs text-text-muted">Not enabled</p>
                </div>
                <button className="btn-primary text-xs">Enable</button>
              </div>
            </div>
          </div>

          <div className="glass-card p-6 space-y-4">
            <h3 className="text-lg font-bold text-text-primary">Account</h3>
            <div className="space-y-2 text-xs text-text-muted">
              <p>Role: <span className="text-text-primary font-semibold">Admin</span></p>
              <p>Joined: <span className="text-text-primary font-semibold">January 2025</span></p>
              <p>Tenant: <span className="text-text-primary font-semibold">Acme Corp</span></p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
