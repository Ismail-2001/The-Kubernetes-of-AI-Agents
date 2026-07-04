import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="glass-card p-12 text-center space-y-6 max-w-md">
        <div className="text-6xl font-bold gradient-text">404</div>
        <div>
          <h2 className="text-xl font-bold text-text-primary">Page not found</h2>
          <p className="text-sm text-text-secondary mt-2">The page you&apos;re looking for doesn&apos;t exist or has been moved.</p>
        </div>
        <Link href="/dashboard" className="btn-primary text-sm inline-flex items-center gap-2">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
