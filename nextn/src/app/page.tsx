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
  // Modal state for product details
  const [selectedDress, setSelectedDress] = useState<Dress | null>(null);

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

    try {
      // Show preview first
      const previewUrl = URL.createObjectURL(file);
      setImagePreview(previewUrl);

      // Upload file using FormData
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/search/visual-match', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error en búsqueda visual:', response.status, errorText);
        throw new Error('Error al procesar la imagen');
      }

      const data = await response.json();
      const results = data.results || [];
      const products: Dress[] = results
        .map((r: any) => r.product)
        .filter(Boolean);

      if (products.length > 0) {
        setAiMessage(`Se encontraron ${products.length} coincidencia(s)`);
        setImageSearchResults(products);
      } else {
        setAiMessage('No se encontraron coincidencias');
        setImageSearchResults([]);
      }
    } catch (error) {
      console.error('Error en búsqueda por imagen:', error);
      setAiMessage(error instanceof Error ? error.message : 'Error procesando la imagen');
      setImageSearchResults([]);
    } finally {
      setIsLoadingImage(false);
      URL.revokeObjectURL(imagePreview as string);
    }
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
      <main className="grow pt-16">
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
                  <div className="w-40 h-60 relative shrink-0">
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
                  <ProductCard key={dress.id} dress={dress} onViewDetails={(d) => setSelectedDress(d)} />
                ))
                : filteredDresses.map((dress) => (
                  <ProductCard key={dress.id} dress={dress} onViewDetails={(d) => setSelectedDress(d)} />
                ))}
            </div>

            {/* Product details modal */}
            {selectedDress && (
              <div className="fixed inset-0 z-50 flex items-center justify-center">
                <div className="absolute inset-0 bg-black/40" onClick={() => setSelectedDress(null)} />
                <div
                  className="relative max-w-3xl w-full mx-4 bg-white dark:bg-gray-900 rounded-lg shadow-lg p-6 z-10"
                  style={{
                    maxHeight: '90vh',
                    overflowY: 'auto',
                    height: '500px', // alto fijo para móviles, puedes ajustar
                  }}
                >
                  <div className="flex justify-between items-start gap-4">
                    <h3 className="text-2xl font-bold">Detalle del producto</h3>
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setSelectedDress(null)}
                      aria-label="Cerrar"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="w-full h-64 relative rounded overflow-hidden bg-muted">
                      <Image
                        src={selectedDress.image.imageUrl}
                        alt={selectedDress.nombre}
                        fill
                        className="object-cover"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <h4 className="text-xl font-semibold">{selectedDress.nombre}</h4>
                      <p className="text-lg text-primary font-bold mt-1">{formatPrice(selectedDress.precio)}</p>

                      <div className="mt-4 prose prose-sm max-w-none text-justify">
                        {selectedDress.descripcion ? (
                          <p>{selectedDress.descripcion}</p>
                        ) : (
                          <p>{selectedDress.shortDescription ?? ''}</p>
                        )}

                        <h5 className="mt-4 font-semibold">Ficha del producto</h5>
                        <ul className="list-disc ml-5">
                          {selectedDress.marca && (
                            <li><strong>Marca:</strong> {selectedDress.marca}</li>
                          )}
                          <li><strong>Modelo:</strong> {selectedDress.modelo ?? selectedDress.nombre}</li>
                          {selectedDress.tipo && <li><strong>Tipo:</strong> {selectedDress.tipo}</li>}
                          {selectedDress.genero && <li><strong>Género:</strong> {selectedDress.genero}</li>}
                          {selectedDress.fit && <li><strong>Fit:</strong> {selectedDress.fit}</li>}
                          {selectedDress.material && <li><strong>Material principal:</strong> {selectedDress.material}</li>}
                          {selectedDress.composicion && <li><strong>Composición:</strong> {selectedDress.composicion}</li>}
                          {selectedDress.temporada && <li><strong>Temporada:</strong> {selectedDress.temporada}</li>}
                          {selectedDress.largo_mangas && <li><strong>Largo de mangas:</strong> {selectedDress.largo_mangas}</li>}
                          {selectedDress.diseno && <li><strong>Diseño:</strong> {selectedDress.diseno}</li>}
                          {selectedDress.estilo && <li><strong>Estilo:</strong> {selectedDress.estilo}</li>}
                          {selectedDress.hecho_en && <li><strong>Hecho en:</strong> {selectedDress.hecho_en}</li>}
                          {selectedDress.condicion && <li><strong>Condición del producto:</strong> {selectedDress.condicion}</li>}
                          {selectedDress.tallas && <li><strong>Tallas:</strong> {selectedDress.tallas.join(', ')}</li>}
                          {selectedDress.colores && <li><strong>Colores:</strong> {selectedDress.colores.join(', ')}</li>}
                        </ul>

                        <div className="mt-6 flex gap-3">
                          {selectedDress.contactPhone ? (
                            <a
                              href={`https://wa.me/${selectedDress.contactPhone}?text=${encodeURIComponent(`Hola, quisiera consultar sobre ${selectedDress.modelo ?? selectedDress.nombre}`)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Button variant="default">Contactar con un asesor</Button>
                            </a>
                          ) : (
                            <a
                              href={`https://wa.me/?text=${encodeURIComponent(`Hola, quisiera consultar sobre ${selectedDress.modelo ?? selectedDress.nombre}`)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Button variant="default">Contactar con un asesor</Button>
                            </a>
                          )}
                          <Button variant="ghost" onClick={() => setSelectedDress(null)}>Cerrar</Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

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
