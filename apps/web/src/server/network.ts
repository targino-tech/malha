export function normalizedMac(value: string) {
  if (!/^(?:[a-f0-9]{12}|[a-f0-9]{2}(?::[a-f0-9]{2}){5}|[a-f0-9]{2}(?:-[a-f0-9]{2}){5})$/i.test(value)) return null;
  return value.replace(/[:-]/g, '').toLowerCase().match(/.{2}/g)!.join(':');
}
