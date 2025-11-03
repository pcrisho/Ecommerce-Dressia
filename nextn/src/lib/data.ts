import type { Dress } from './types';
import { PlaceHolderImages } from './placeholder-images';

const dressImages = PlaceHolderImages.filter(img => img.id.startsWith('dress-'));

export const vestidos: Dress[] = [
  {
    id: '1',
    nombre: 'Blusa "Bembella White"',
    precio: 120,
    image: dressImages.find(i => i.id === 'dress-1')!
  },
  {
    id: '2',
    nombre: 'Blusa "Bembella"',
    precio: 180,
    image: dressImages.find(i => i.id === 'dress-2')!
  },
  {
    id: '3',
    nombre: 'Blusa "Malva"',
    precio: 150,
    image: dressImages.find(i => i.id === 'dress-3')!
  },
  {
    id: '4',
    nombre: 'Blusa "Matchy"',
    precio: 95,
    image: dressImages.find(i => i.id === 'dress-4')!
  },
  {
    id: '5',
    nombre: 'Blusa "Topp"',
    precio: 135,
    image: dressImages.find(i => i.id === 'dress-5')!
  },
];
