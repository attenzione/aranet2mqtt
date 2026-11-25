export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function countdown(end: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((end - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Z2M's air_quality words, and the colour of the sensor's light each one comes from. */
export const AIR_QUALITY: Record<string, { label: string; light: string }> = {
  excellent: { label: 'Excellent', light: 'green' },
  moderate: { label: 'Moderate', light: 'yellow' },
  poor: { label: 'Poor', light: 'red' },
  unknown: { label: 'Unknown', light: 'unknown' },
};
