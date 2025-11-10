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
// Local training embeddings index (fallback metadata lookup)
import trainingEmbeddings from '../../data/training_embeddings.json';
import { simulateImageSearch } from '@/ai/flows/image-search-simulation';
import type { Dress } from '@/lib/types';
import { cn, formatPrice } from '@/lib/utils';

export default function Home() {
  const [searchTerm, setSearchTerm] = useState('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [imageSearchResults, setImageSearchResults] = useState<Dress[]>([]);
  // Other matched products (after the top 3)
  const [imageSearchOther, setImageSearchOther] = useState<Dress[]>([]);
  const [imageSearchUnmatched, setImageSearchUnmatched] = useState<Array<{ filename: string; score: number; imageUrl?: string }>>([]);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  // Default to using Vertex for embeddings unless the user unchecks the box
  const [preferVertex, setPreferVertex] = useState(true);
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
  setImageSearchOther([]);

    try {
      // Show preview first
      const previewUrl = URL.createObjectURL(file);
      setImagePreview(previewUrl);

      // Upload file using FormData
      const formData = new FormData();
      formData.append('file', file);

      const url = '/api/search/visual-match-vertex' + (preferVertex ? '?prefer=vertex' : '');
      const response = await fetch(url, {
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

      // Map results: try to resolve product objects; keep unmatched as filename+score
  type Mapped = { product: Dress | null; filename?: string; score?: number; imageUrl?: string; rawScore?: number; rank?: number };
      const mapped: Mapped[] = results.map((r: any) => {
        // Backend may return: { id, product, productId, distance, score, similarity, metadata }
        const raw = r as any;
        const o = raw as { id?: string; productId?: string; filename?: string; score?: number; similarity?: number; distance?: number; metadata?: any };

  // Some backends may include a full `product` object; prefer that if present
  let product = raw.product ?? (o.productId ? allDresses.find((d) => d.id === String(o.productId)) : null);

        // Resolve filename / imageUrl: prefer explicit filename or metadata, else search local trainingEmbeddings
        let filename = o.filename || '';
        let imageUrl: string | undefined = undefined;
        if (!filename && o.metadata) {
          // Try common metadata shapes
          if (typeof o.metadata === 'object') {
            filename = o.metadata.filename || o.metadata.file || o.metadata.path || '';
            if (!imageUrl && o.metadata.gs_uri) imageUrl = String(o.metadata.gs_uri).replace('gs://', 'https://storage.googleapis.com/');
          }
        }
        if (!filename && o.id) {
          const found = (trainingEmbeddings as any[]).find((e) => (e.filename || '').includes(String(o.id)));
          if (found) {
            filename = found.filename || '';
            if (filename && String(filename).startsWith('gs://')) imageUrl = String(filename).replace('gs://', 'https://storage.googleapis.com/');
            // If the training entry includes a productId, resolve it to a Dress so it shows as a ProductCard
            if (!product && found.productId) {
              try {
                const pid = String(found.productId);
                const resolved = allDresses.find((d) => d.id === pid);
                if (resolved) {
                  // assign to product variable in this scope so matched items render as ProductCard
                  product = resolved;
                }
              } catch (err) {
                // ignore resolution errors — we'll fall back to unmatched
              }
            }
          }
        }
        if (!imageUrl && filename && String(filename).startsWith('gs://')) imageUrl = String(filename).replace('gs://', 'https://storage.googleapis.com/');

        // Compute similarity (0..1) from available fields and a ranking value where LOWER means MORE similar.
        let similarity: number | undefined = undefined;
        let rawScore: number | undefined = undefined;
        if (typeof o.similarity === 'number') {
          similarity = o.similarity;
          rawScore = o.similarity;
        } else if (typeof o.score === 'number') {
          const v = o.score;
          rawScore = v;
          // Heuristic: if score is in [-1,1] treat as cosine-like (higher better), else treat as distance-like (lower better)
          if (v >= -1 && v <= 1) similarity = (v + 1) / 2;
          else similarity = 1 / (1 + Math.abs(v));
        } else if (typeof o.distance === 'number') {
          const v = o.distance;
          rawScore = v;
          // distance-like: convert to similarity for display but keep raw distance for ranking (lower better)
          similarity = (v >= -1 && v <= 1) ? (v + 1) / 2 : 1 / (1 + Math.abs(v));
        }

        // Determine rank: lower rank -> more similar. For distance-like metrics use rawScore (lower better).
        // For similarity metrics (0..1) use negative similarity so higher similarity sorts first when sorting ascending.
        let rank: number | undefined = undefined;
        if (typeof rawScore === 'number') {
          // if rawScore outside [-1,1], it's distance-like (lower better)
          if (rawScore < -1 || rawScore > 1) {
            rank = rawScore;
          } else if (typeof similarity === 'number') {
            rank = -similarity; // higher similarity -> lower rank
          }
        } else if (typeof similarity === 'number') {
          rank = -similarity;
        }

        return { product, filename, score: similarity !== undefined ? similarity * 100 : (o.score ?? 0), imageUrl, rawScore, rank } as Mapped;
      });

      // Collect matched products with scores, sort by similarity (desc), dedupe and split into top3 + rest
      const matchedMapped = mapped.filter((m: Mapped) => m.product) as Array<Mapped>;
  // Sort by rank ascending (lower rank = more similar). Items without rank fall to the end.
  matchedMapped.sort((a, b) => (typeof a.rank === 'number' ? a.rank : Infinity) - (typeof b.rank === 'number' ? b.rank : Infinity));
      const seenIds = new Set<string>();
      const deduped: Dress[] = [];
      for (const m of matchedMapped) {
        const p = m.product as Dress;
        if (!p) continue;
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          deduped.push(p);
        }
      }
      const top3 = deduped.slice(0, 3);
      const others = deduped.slice(3);

      const unmatched = mapped.filter((m: Mapped) => !m.product).map((m: Mapped) => ({ filename: m.filename || '', score: m.score || 0, imageUrl: m.imageUrl }));
      // Order unmatched by similarity descending
      unmatched.sort((a, b) => (b.score || 0) - (a.score || 0));

      // Show source if present
      if (data.source) {
        setAiMessage(`Fuente de embeddings: ${data.source}${data.vertexError ? ' (vertex error: ' + data.vertexError + ')' : ''}`);
      }

      if (top3.length > 0 || unmatched.length > 0 || others.length > 0) {
        setAiMessage((prev) => (data.source ? `Fuente de embeddings: ${data.source}` : prev));
        // Show top 3 most similar products first, then "others" below
        setImageSearchResults(top3);
        setImageSearchOther(others);
        setImageSearchUnmatched(unmatched);
      } else {
        setAiMessage('No se encontraron coincidencias');
        setImageSearchResults([]);
        setImageSearchUnmatched([]);
      }
    } catch (error) {
      console.error('Error en búsqueda por imagen:', error);
      setAiMessage(error instanceof Error ? error.message : 'Error procesando la imagen');
      setImageSearchResults([]);
      setImageSearchOther([]);
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
                    <div className="mb-2 flex items-center justify-center md:justify-start gap-3">
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={preferVertex} onChange={(e) => setPreferVertex(e.target.checked)} />
                        <span>Preferir Vertex</span>
                      </label>
                    </div>
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
              {isImageSearchActive ? (
                <>
                  {imageSearchResults.map((dress) => (
                    <ProductCard key={dress.id} dress={dress} onViewDetails={(d) => setSelectedDress(d)} />
                  ))}
                  {/* Otros matches (después de los top 3) */}
                  {imageSearchOther.length > 0 && (
                    <div className="col-span-full mt-4">
                      <h3 className="text-xl font-semibold mb-4">Prendas que te podrían interesar</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                        {imageSearchOther.map((dress) => (
                          <ProductCard key={`other-${dress.id}`} dress={dress} onViewDetails={(d) => setSelectedDress(d)} />
                        ))}
                      </div>
                    </div>
                  )}
                  {imageSearchUnmatched.map((u: any, idx) => (
                    <div key={`unmatched-${idx}`} className="border rounded-lg p-4 bg-white dark:bg-gray-900 flex gap-4 items-center">
                      <div className="w-28 h-20 relative shrink-0 bg-muted rounded overflow-hidden">
                        {u.imageUrl ? (
                          <Image src={u.imageUrl} alt={u.filename || 'Resultado'} fill className="object-cover" />
                        ) : (
                          <div className="flex items-center justify-center h-full w-full text-sm text-muted-foreground">Sin imagen</div>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm text-muted-foreground">Archivo</div>
                        <div className="font-medium mt-1 wrap-break-word">{u.filename || u.imageUrl || ''}</div>
                        <div className="text-sm text-muted-foreground mt-2">Similitud: {typeof u.score === 'number' ? `${Math.round(u.score)}%` : String(u.score)}</div>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                filteredDresses.map((dress) => (
                  <ProductCard key={dress.id} dress={dress} onViewDetails={(d) => setSelectedDress(d)} />
                ))
              )}
            </div>

            {/* Product details modal */}
            {selectedDress && (
              <div className="fixed inset-0 z-50 flex items-center justify-center">
                <div className="absolute inset-0 bg-black/40" onClick={() => setSelectedDress(null)} />
                  <div
                  className="relative max-w-3xl w-full mx-4 bg-white dark:bg-gray-900 rounded-lg shadow-lg p-6 z-10 max-h-[90vh] overflow-y-auto h-[500px]"
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
