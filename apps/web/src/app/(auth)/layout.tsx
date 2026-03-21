import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-surface-0 relative overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-brand-500/[0.06] blur-[100px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 px-6 h-14 flex items-center">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <path d="M6 7l4 4-4 4M11 15h5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="font-semibold text-sm tracking-tight text-text-primary">kmmzavod</span>
        </Link>
      </header>

      {/* Centered content */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-6 pb-12">
        {children}
      </main>
    </div>
  );
}