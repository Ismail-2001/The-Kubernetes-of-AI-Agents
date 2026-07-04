export default function Loading() {
  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="space-y-2">
        <div className="h-8 bg-white/5 rounded w-48 animate-pulse" />
        <div className="h-4 bg-white/5 rounded w-72 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-card p-6 animate-pulse">
            <div className="h-4 bg-white/5 rounded w-1/3 mb-4" />
            <div className="h-8 bg-white/5 rounded w-1/2 mb-2" />
            <div className="h-3 bg-white/5 rounded w-2/3" />
          </div>
        ))}
      </div>
      <div className="glass-card p-6 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-1/4 mb-6" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-3 border-b border-white/5">
            <div className="h-3 bg-white/5 rounded w-1/4" />
            <div className="h-3 bg-white/5 rounded w-1/6" />
            <div className="h-3 bg-white/5 rounded w-1/8" />
          </div>
        ))}
      </div>
    </div>
  );
}
