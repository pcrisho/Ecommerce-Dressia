import type { Dress } from './types';
import { PlaceHolderImages } from './placeholder-images';

const dressImages = PlaceHolderImages.filter(img => img.id.startsWith('dress-'));

export const vestidos: Dress[] = [
  { 
    id: '1', 
    nombre: 'Vestido "Serenidad"', 
    precio: 120, 
    image: dressImages.find(i => i.id === 'dress-1')! 
  },
  { 
    id: '2', 
    nombre: 'Vestido "Noche"', 
    precio: 180, 
    image: dressImages.find(i => i.id === 'dress-2')! 
  },
  { 
    id: '3', 
    nombre: 'Vestido "Aura"', 
    precio: 150, 
    image: dressImages.find(i => i.id === 'dress-3')! 
  },
  { 
    id: '4', 
    nombre: 'Vestido "Brisa"', 
    precio: 95, 
    image: dressImages.find(i => i.id === 'dress-4')! 
  },
  { 
    id: '5', 
    nombre: 'Vestido "Eclipse"', 
    precio: 135, 
    image: dressImages.find(i => i.id === 'dress-5')! 
  },
  { 
    id: '6', 
    nombre: 'Vestido "Dorado"', 
    precio: 250, 
    image: dressImages.find(i => i.id === 'dress-6')! 
  },
];
