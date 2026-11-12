/**
 * Marketing-neutral shell shared by every signed-out screen.
 *
 * Deliberately minimal: a sign-in page should not be where someone discovers
 * what the portal can do.
 */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <div
            className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-b from-brand-300 via-brand-500 to-brand-600 text-sm font-bold text-white"
            aria-hidden
          >
            SML
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight text-slate-900">crossrentel</p>
            <p className="text-xs text-slate-500">Vendor portal</p>
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">{children}</main>

      <footer className="border-t border-slate-200 bg-white py-4">
        <p className="text-center text-xs text-slate-400">
          Sanghvi Movers Limited &middot; authorised vendors only
        </p>
      </footer>
    </div>
  );
}