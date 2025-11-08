import Image from 'next/image';
import type { Dress } from '@/lib/types';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatPrice } from '@/lib/utils';

export function ProductCard({
  dress,
  onViewDetails,
}: {
  dress: Dress;
  onViewDetails?: (dress: Dress) => void;
}) {
  return (
    <Card className="overflow-hidden transition-all duration-300 hover:shadow-lg group border-none shadow-sm rounded-lg">
      <CardContent className="p-0">
        <div className="aspect-[3/4] overflow-hidden relative">
          <Image
            src={dress.image.imageUrl}
            alt={dress.nombre}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            data-ai-hint={dress.image.imageHint}
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        </div>
        <div className="p-4 bg-card">
          <h3 className="text-lg font-medium text-foreground truncate">{dress.nombre}</h3>
          <p className="text-xl font-bold text-primary mt-1">{formatPrice(dress.precio)}</p>
        </div>
      </CardContent>
      <CardFooter className="p-4 pt-0 bg-card">
        {/* Light mode: pale yellow button. Dark mode: darker amber + readable text for contrast */}
        <Button
          variant="default"
          className="w-full rounded-md bg-amber-100 text-foreground dark:bg-amber-700 dark:text-white"
          onClick={() => onViewDetails?.(dress)}
        >
          Ver Detalle
        </Button>
      </CardFooter>
    </Card>
  );
}
