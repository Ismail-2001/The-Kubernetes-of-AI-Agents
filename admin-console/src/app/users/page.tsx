"use client";

import { useState } from "react";
import { Suspense } from "react";
import {
  Users as UsersIcon,
  Plus,
  Search,
  Shield,
  CheckCircle,
  XCircle,
  Edit3,
  Trash2,
  Key,
} from "lucide-react";
import { ApiErrorBoundary, SkeletonTable, EmptyState } from "@/components/ErrorStates";

interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "operator" | "viewer";
  status: "active" | "inactive";
  lastLogin: string;
  createdAt: string;
  namespaces: string[];
}

const mockUsers: User[] = [
  { id: "u-001", name: "Jane Doe", email: "jane@egaop.io", role: "admin", status: "active", lastLogin: new Date(Date.now() - 3600000).toISOString(), createdAt: "2025-01-01T00:00:00Z", namespaces: ["production", "staging", "development"] },
  { id: "u-002", name: "John Smith", email: "john@egaop.io", role: "operator", status: "active", lastLogin: new Date(Date.now() - 86400000).toISOString(), createdAt: "2025-02-15T00:00:00Z", namespaces: ["production", "staging"] },
  { id: "u-003", name: "Alice Chen", email: "alice@egaop.io", role: "viewer", status: "active", lastLogin: new Date(Date.now() - 172800000).toISOString(), createdAt: "2025-03-01T00:00:00Z", namespaces: ["staging"] },
  { id: "u-004", name: "Bob Wilson", email: "bob@egaop.io", role: "operator", status: "inactive", lastLogin: new Date(Date.now() - 604800000).toISOString(), createdAt: "2025-03-10T00:00:00Z", namespaces: ["development"] },
];

const roleConfig: Record<string, { color: string; bg: string; icon: typeof Shield }> = {
  admin: { color: "text-error", bg: "bg-error/10", icon: Shield },
  operator: { color: "text-brand-primary", bg: "bg-brand-primary/10", icon: Key },
  viewer: { color: "text-text-muted", bg: "bg-white/5", icon: UsersIcon },
};

function UserRow({ user }: { user: User }) {
  const role = roleConfig[user.role];
  const RoleIcon = role.icon;
  const initials = user.name.split(" ").map((n) => n[0]).join("");

  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-primary/20 to-brand-secondary/20 border border-white/10 flex items-center justify-center text-sm font-bold text-brand-primary">
            {initials}
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">{user.name}</p>
            <p className="text-xs text-text-muted">{user.email}</p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider border ${role.bg} ${role.color} border-current/20`}>
          <RoleIcon className="w-3 h-3" />
          {user.role}
        </span>
      </td>
      <td className="px-6 py-4">
        <div className="flex flex-wrap gap-1">
          {user.namespaces.map((ns) => (
            <span key={ns} className="px-2 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] font-medium text-text-secondary">
              {ns}
            </span>
          ))}
        </div>
      </td>
      <td className="px-6 py-4">
        <span className={`inline-flex items-center gap-1.5 text-xs font-bold ${user.status === "active" ? "text-success" : "text-text-muted"}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${user.status === "active" ? "bg-success" : "bg-text-muted"}`} />
          {user.status}
        </span>
      </td>
      <td className="px-6 py-4 text-xs text-text-muted">{new Date(user.lastLogin).toLocaleDateString()}</td>
      <td className="px-6 py-4">
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Edit3 className="w-4 h-4" /></button>
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Trash2 className="w-4 h-4" /></button>
        </div>
      </td>
    </tr>
  );
}

function UserList() {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");

  const filtered = mockUsers.filter((u) => {
    const matchSearch = !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase());
    const matchRole = roleFilter === "all" || u.role === roleFilter;
    return matchSearch && matchRole;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users..."
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:border-brand-primary outline-none"
        >
          <option value="all">All Roles</option>
          <option value="admin">Admin</option>
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
        </select>
        <button className="btn-primary text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Invite User
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {["User", "Role", "Namespaces", "Status", "Last Login", ""].map((h) => (
                <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => <UserRow key={u.id} user={u} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={6}>
                <EmptyState label="No users found" description="Invite team members to collaborate on the platform" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function UsersPage() {
  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Users & RBAC</h1>
            <p className="text-sm text-text-secondary mt-1">Manage team access and role-based permissions</p>
          </div>
        </div>
        <Suspense fallback={<SkeletonTable rows={5} />}>
          <UserList />
        </Suspense>
      </div>
    </ApiErrorBoundary>
  );
}
