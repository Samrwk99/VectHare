/** Inventory refusal is a safety result, NOT evidence of missing vectors or backend failure. */
export function isUnverifiedInventoryRead(error) {
    return error?.code === 'VECTHARE_E06_UNVERIFIED_READ'
        || /shared-collection read unverified \(authoritative-inventory-contract-unavailable\)/.test(String(error?.message || ''));
}
