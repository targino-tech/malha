export function email(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Forneça um e-mail válido.');
  return normalized;
}
