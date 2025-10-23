import Link from 'next/link';

export function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-card/80 backdrop-blur-xl border-b border-border">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <Link
          href="/"
          className="text-xl md:text-2xl font-bold text-foreground font-headline"
        >
          DRESSIA
        </Link>
      </div>
    </header>
  );
}
