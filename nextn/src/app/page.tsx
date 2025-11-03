'use client';

import { useState, useMemo, useRef, type ChangeEvent } from 'react';
import Image from 'next/image';
import { Camera, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Header } from '@/components/header';
import { ProductCard } from '@/components/product-card';
import { Loader } from '@/components/ui/loader';
import { vestidos as allDresses } from '@/lib/data';
import { simulateImageSearch } from '@/ai/flows/image-search-simulation';
import type { Dress } from '@/lib/types';
import { cn, formatPrice } from '@/lib/utils';

export default function Home() {
  const [searchTerm, setSearchTerm] = useState('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [imageSearchResults, setImageSearchResults] = useState<Dress[]>([]);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredDresses = useMemo(() => {
    if (!searchTerm) return allDresses;
    return allDresses.filter((dress) =>
      dress.nombre.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [searchTerm]);

  const handleImageSearchClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoadingImage(true);
    setSearchTerm('');
    setAiMessage(null);
    setImageSearchResults([]);

    // Show preview
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onloadend = async () => {
      const base64Data = reader.result as string;
      setImagePreview(base64Data);

      try {
        // Upload file using FormData to the visual-match API route
        const fd = new FormData();
        fd.append('file', file);

        const resp = await fetch('/api/search/visual-match', {
          method: 'POST',
          body: fd,
        });

        if (!resp.ok) {
          const text = await resp.text();
          setAiMessage('Error en búsqueda por imagen');
          console.error('visual-match error', resp.status, text);
          setIsLoadingImage(false);
          return;
        }

        const json = await resp.json();

        const results = json.results ?? [];
        const products: Dress[] = results
          .map((r: any) => r.product)
          .filter(Boolean);

        if (products.length > 0) {
          setAiMessage(`Se encontraron ${products.length} coincidencia(s)`);
          setImageSearchResults(products);
        } else {
          setAiMessage('No se encontraron coincidencias.');
          setImageSearchResults([]);
        }
      } catch (err) {
        console.error('Error uploading image for visual match', err);
        setAiMessage('Error procesando la imagen.');
      } finally {
        setIsLoadingImage(false);
      }
    };
  };

  const isSearching = searchTerm.length > 0;
  const isImageSearchActive = imagePreview !== null;

  const getHeading = () => {
    if (isImageSearchActive) return "Resultados de Búsqueda por Imagen";
    if (isSearching) return `Resultados para "${searchTerm}"`;
    return "Productos Destacados";
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow pt-16">
        <div className="container mx-auto px-4 py-8 md:py-12">
          <section className="text-center mb-12 max-w-2xl mx-auto">
            <div className="relative mb-4">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Buscar por nombre..."
                className="w-full pl-12 pr-4 py-6 text-lg rounded-full shadow-sm"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  // Reset image search when typing
                  setImagePreview(null);
                  setAiMessage(null);
                  setImageSearchResults([]);
                }}
              />
            </div>
            <Button
              variant="outline"
              className="rounded-full"
              onClick={handleImageSearchClick}
            >
              <Camera className="mr-2 h-4 w-4" />
              Buscar por Imagen
            </Button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
              accept="image/*"
            />
          </section>

          <section>
            <h2 className="text-3xl font-bold mb-8 text-center font-headline">
              {getHeading()}
            </h2>

            {isImageSearchActive && (
              <div className="flex flex-col items-center mb-8 gap-6 p-6 border rounded-lg max-w-3xl mx-auto bg-card shadow-sm">
                <div className="flex flex-col md:flex-row items-center gap-6 w-full">
                  <div className="w-40 h-60 relative flex-shrink-0">
                    {imagePreview && (
                      <Image
                        src={imagePreview}
                        alt="Vista previa"
                        layout="fill"
                        objectFit="cover"
                        className="rounded-md"
                      />
                    )}
                  </div>
                  <div className="text-center md:text-left">
                    {isLoadingImage && (
                       <div className="flex items-center justify-center flex-col gap-2">
                        <Loader />
                        <p className="text-muted-foreground">Procesando imagen...</p>
                      </div>
                    )}
                    {aiMessage && <p className="text-muted-foreground">{aiMessage}</p>}
                  </div>
                </div>
              </div>
            )}
            
            <div
              className={cn(
                'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 transition-opacity duration-500',
                isLoadingImage ? 'opacity-0' : 'opacity-100'
              )}
            >
              {isImageSearchActive
                ? imageSearchResults.map((dress) => (
                    <ProductCard key={dress.id} dress={dress} />
                  ))
                : filteredDresses.map((dress) => (
                    <ProductCard key={dress.id} dress={dress} />
                  ))}
            </div>

            {!isImageSearchActive && filteredDresses.length === 0 && (
              <div className="text-center py-16">
                <p className="text-muted-foreground text-lg">No se encontraron vestidos.</p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
