"use client";

import { Settings, Shield, Bell, Key, Globe } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
      <div>
        <h1 className="text-3xl font-bold text-text-primary">Settings</h1>
        <p className="text-sm text-text-secondary mt-1">
          Platform configuration and preferences
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="glass-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-primary/10 flex items-center justify-center">
                <Globe className="w-5 h-5 text-brand-primary" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">General</h3>
                <p className="text-xs text-text-muted">Basic platform settings</p>
              </div>
            </div>
            <div className="space-y-4 pt-4 border-t border-white/5">
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">
                  Platform Name
                </label>
                <input
                  type="text"
                  defaultValue="E-GAOP Production"
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:outline-none focus:border-brand-primary/50 transition-all"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">
                  Default Namespace
                </label>
                <input
                  type="text"
                  defaultValue="default"
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:outline-none focus:border-brand-primary/50 transition-all"
                />
              </div>
            </div>
          </div>

          <div className="glass-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-success/10 flex items-center justify-center">
                <Shield className="w-5 h-5 text-success" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">Security</h3>
                <p className="text-xs text-text-muted">Authentication and access control</p>
              </div>
            </div>
            <div className="space-y-3 pt-4 border-t border-white/5">
              {[
                { label: "Enforce mTLS for all gRPC connections", checked: true },
                { label: "Require signed agent manifests", checked: true },
                { label: "Enable PII detection in tool calls", checked: true },
                { label: "Auto-revoke expired tokens", checked: false },
              ].map((item) => (
                <label key={item.label} className="flex items-center justify-between py-2">
                  <span className="text-sm text-text-secondary">{item.label}</span>
                  <div
                    className={`w-10 h-6 rounded-full transition-colors relative ${
                      item.checked ? "bg-brand-primary" : "bg-white/10"
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                        item.checked ? "left-5" : "left-1"
                      }`}
                    />
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="glass-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-warning/10 flex items-center justify-center">
                <Bell className="w-5 h-5 text-warning" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">Notifications</h3>
                <p className="text-xs text-text-muted">Alert and notification preferences</p>
              </div>
            </div>
            <div className="space-y-3 pt-4 border-t border-white/5">
              {[
                { label: "Agent failure alerts", checked: true },
                { label: "Policy violation alerts", checked: true },
                { label: "Cost threshold alerts ($100/day)", checked: false },
                { label: "Weekly summary emails", checked: true },
              ].map((item) => (
                <label key={item.label} className="flex items-center justify-between py-2">
                  <span className="text-sm text-text-secondary">{item.label}</span>
                  <div
                    className={`w-10 h-6 rounded-full transition-colors relative ${
                      item.checked ? "bg-brand-primary" : "bg-white/10"
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                        item.checked ? "left-5" : "left-1"
                      }`}
                    />
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                <Key className="w-5 h-5 text-accent" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">API Keys</h3>
                <p className="text-xs text-text-muted">Manage platform API keys</p>
              </div>
            </div>
            <div className="space-y-3 pt-4 border-t border-white/5">
              <div className="p-3 bg-white/5 rounded-xl">
                <p className="text-xs font-mono text-text-secondary truncate">
                  egaop_prod_****...****8f3a
                </p>
                <p className="text-[10px] text-text-muted mt-1">Created 2 days ago</p>
              </div>
              <button className="btn-secondary text-xs w-full">Generate New Key</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
