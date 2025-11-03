"use client";

import React from 'react';

export function Header() {
  const handleReload = () => {
    // Full page reload to reset search state / app
    if (typeof window !== 'undefined') window.location.reload();
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-card/80 backdrop-blur-xl border-b border-border">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <button
          onClick={handleReload}
          className="text-xl md:text-2xl font-bold text-foreground font-headline bg-transparent border-0 p-0 cursor-pointer"
          aria-label="Recargar página"
        >
          DRESSIA
        </button>
      </div>
    </header>
  );
}
