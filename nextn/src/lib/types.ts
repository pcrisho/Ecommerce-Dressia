import type { ImagePlaceholder } from './placeholder-images';

export type Dress = {
  id: string;
  nombre: string;
  precio: number;
  image: ImagePlaceholder;
  // Descriptions
  shortDescription?: string;
  descripcion?: string;

  // Product details
  marca?: string;
  modelo?: string;
  tipo?: string;
  genero?: string;
  fit?: string;
  material?: string;
  composicion?: string;
  temporada?: string;
  largo_mangas?: string;
  diseno?: string;
  estilo?: string;
  hecho_en?: string;
  condicion?: string;

  // Inventory / presentation
  sku?: string;
  tallas?: string[];
  colores?: string[];
  stock?: number | Record<string, number>;

  // Contact
  contactPhone?: string; // international format without +, e.g. '51912345678'

  // Flexible attributes
  attributes?: Record<string, string>;
};
