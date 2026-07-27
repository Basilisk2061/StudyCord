import { supabase } from './supabase';

export const SERVER_ICONS_BUCKET = 'server-icons';
export const SERVER_ICON_MAX_BYTES = 2 * 1024 * 1024;

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

async function hasExpectedSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());

  if (file.type === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (file.type === 'image/png') {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return pngSignature.every((value, index) => bytes[index] === value);
  }
  if (file.type === 'image/webp') {
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    );
  }
  return false;
}

async function assertRasterDecodes(file) {
  if (typeof createImageBitmap === 'function') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (!bitmap.width || !bitmap.height) throw new Error('Image has invalid dimensions.');
      return;
    } finally {
      bitmap?.close();
    }
  }

  const previewUrl = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth && image.naturalHeight) resolve();
        else reject(new Error('Image has invalid dimensions.'));
      };
      image.onerror = () => reject(new Error('The selected file is not a readable raster image.'));
      image.src = previewUrl;
    });
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

export async function validateServerIcon(file) {
  if (!file) throw new Error('Choose an image to upload.');

  const extension = MIME_EXTENSIONS[file.type];
  if (!extension) {
    throw new Error('Choose a JPEG, PNG, or WebP image. SVG, GIF, and other formats are not supported.');
  }

  if (!file.size) throw new Error('The selected image is empty.');
  if (file.size > SERVER_ICON_MAX_BYTES) {
    throw new Error('Server icons must be 2 MB or smaller.');
  }
  if (!(await hasExpectedSignature(file))) {
    throw new Error('The file contents do not match the selected image format.');
  }

  try {
    await assertRasterDecodes(file);
  } catch {
    throw new Error('The selected file is not a readable JPEG, PNG, or WebP image.');
  }

  return extension;
}

export function getServerIconPublicUrl(iconPath) {
  if (!iconPath) return null;
  return supabase.storage.from(SERVER_ICONS_BUCKET).getPublicUrl(iconPath).data.publicUrl;
}
