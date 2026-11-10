import type { BinaryFileData } from '@excalidraw/excalidraw/types';

export async function loadImage(id: string): Promise<BinaryFileData> {
  const response = await fetch(`/api/assets/${id}`);
  if (!response.ok) throw new Error('Не удалось загрузить изображение. Проверьте соединение и повторите.');
  const blob = await response.blob();
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
    reader.readAsDataURL(blob);
  });
  return {
    id: id as BinaryFileData['id'],
    mimeType: blob.type as BinaryFileData['mimeType'],
    dataURL: dataURL as BinaryFileData['dataURL'],
    created: Date.now(),
  };
}

export async function uploadImage(file: File) {
  if (file.size > 2 * 1024 * 1024) throw new Error('Максимальный размер изображения — 2 МиБ.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Выберите PNG, JPEG или WebP.');
  const bitmap = await createImageBitmap(file);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (dimensions.width * dimensions.height > 24_000_000) throw new Error('Изображение слишком большое: максимум 24 мегапикселя.');
  const response = await fetch('/api/assets', { method: 'POST', body: file });
  if (!response.ok) {
    const message = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(message.error ?? 'Не удалось сохранить изображение.');
  }
  const { id } = await response.json() as { id: string };
  return { file: await loadImage(id), ...dimensions };
}
