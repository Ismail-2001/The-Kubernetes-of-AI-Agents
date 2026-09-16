"use client";

import { useState } from "react";
import {
  Bell,
  Mail,
  Webhook,
  Plus,
  CheckCircle,
  XCircle,
  Edit3,
  Trash2,
  TestTube,
  Send,
} from "lucide-react";
import { ApiErrorBoundary, EmptyState } from "@/components/ErrorStates";

interface NotificationChannel {
  id: string;
  name: string;
  type: "email" | "webhook" | "slack";
  enabled: boolean;
  config: string;
  lastTriggered?: string;
}

interface NotificationRule {
  id: string;
  name: string;
  event: string;
  channel: string;
  enabled: boolean;
}

const mockChannels: NotificationChannel[] = [
  { id: "ch-001", name: "Ops Team Email", type: "email", enabled: true, config: "ops@egaop.io", lastTriggered: new Date(Date.now() - 3600000).toISOString() },
  { id: "ch-002", name: "Slack Alerts", type: "slack", enabled: true, config: "https://hooks.slack.com/services/xxx", lastTriggered: new Date(Date.now() - 7200000).toISOString() },
  { id: "ch-003", name: "PagerDuty Webhook", type: "webhook", enabled: false, config: "https://events.pagerduty.com/v2/enqueue" },
];

const mockRules: NotificationRule[] = [
  { id: "rule-001", name: "Agent Failure Alert", event: "agent.status_changed → failed", channel: "Ops Team Email", enabled: true },
  { id: "rule-002", name: "High Error Rate", event: "metrics.error_rate > 5%", channel: "Slack Alerts", enabled: true },
  { id: "rule-003", name: "Namespace Quota Warning", event: "quota.usage > 80%", channel: "Slack Alerts", enabled: true },
  { id: "rule-004", name: "Execution Completed", event: "execution.completed", channel: "Ops Team Email", enabled: false },
];

const typeIcons: Record<string, typeof Mail> = { email: Mail, webhook: Webhook, slack: Send };

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState<"channels" | "rules">("channels");

  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Notifications</h1>
            <p className="text-sm text-text-secondary mt-1">Configure alert channels and notification rules</p>
          </div>
        </div>

        <div className="flex gap-1 p-1 bg-white/5 rounded-xl w-fit">
          {(["channels", "rules"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all capitalize ${
                activeTab === tab ? "bg-brand-primary text-white shadow-lg shadow-brand-primary/20" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "channels" && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button className="btn-primary text-sm flex items-center gap-2">
                <Plus className="w-4 h-4" />
                Add Channel
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {mockChannels.map((ch) => {
                const Icon = typeIcons[ch.type];
                return (
                  <div key={ch.id} className="glass-card p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
                          <Icon className="w-5 h-5 text-brand-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-text-primary">{ch.name}</p>
                          <p className="text-xs text-text-muted capitalize">{ch.type}</p>
                        </div>
                      </div>
                      <span className={`w-2 h-2 rounded-full ${ch.enabled ? "bg-success" : "bg-text-muted"}`} />
                    </div>
                    <code className="block text-xs text-text-muted font-mono truncate bg-white/[0.02] p-2 rounded-lg border border-white/5">
                      {ch.config}
                    </code>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-muted">
                        {ch.lastTriggered ? `Last: ${new Date(ch.lastTriggered).toLocaleString()}` : "Never triggered"}
                      </span>
                      <div className="flex items-center gap-1">
                        <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><TestTube className="w-3.5 h-3.5" /></button>
                        <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Edit3 className="w-3.5 h-3.5" /></button>
                        <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "rules" && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button className="btn-primary text-sm flex items-center gap-2">
                <Plus className="w-4 h-4" />
                Add Rule
              </button>
            </div>
            <div className="glass-card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5">
                    {["Rule", "Event Trigger", "Channel", "Status", ""].map((h) => (
                      <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mockRules.map((rule) => (
                    <tr key={rule.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-4 text-sm font-semibold text-text-primary">{rule.name}</td>
                      <td className="px-6 py-4">
                        <code className="text-xs font-mono text-text-secondary bg-white/5 px-2 py-1 rounded">{rule.event}</code>
                      </td>
                      <td className="px-6 py-4 text-xs text-text-secondary">{rule.channel}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-bold ${rule.enabled ? "text-success" : "text-text-muted"}`}>
                          <div className={`w-1.5 h-1.5 rounded-full ${rule.enabled ? "bg-success" : "bg-text-muted"}`} />
                          {rule.enabled ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1">
                          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Edit3 className="w-4 h-4" /></button>
                          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </ApiErrorBoundary>
  );
}
