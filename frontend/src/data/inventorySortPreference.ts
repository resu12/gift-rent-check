import type { InventorySort } from './inventorySort.ts';

/** The v2 preference defaults once, while retaining later explicit choices. */
export function parseInventorySortPreference(value: string | null): InventorySort {
  switch (value) {
    case 'default':
    case 'name_asc':
    case 'price_desc':
    case 'price_asc':
    case 'last_rented':
    case 'rental_ending':
      return value;
    default:
      return 'last_rented';
  }
}
