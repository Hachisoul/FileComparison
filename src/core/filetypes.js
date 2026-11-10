'use strict';

const path = require('path');

// Images and videos are excluded from comparison by design.
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'bmp', 'dib', 'tif', 'tiff', 'webp', 'ico', 'icns',
  'svg', 'svgz', 'heic', 'heif', 'avif', 'psd', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf',
  'rw2', 'tga', 'jxl', 'jp2', 'emf', 'wmf', 'xcf',
]);

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'f4v', 'webm', 'mpg', 'mpeg', 'mpe', 'm2v',
  '3gp', '3g2', 'ts', 'mts', 'm2ts', 'vob', 'ogv', 'rm', 'rmvb', 'asf', 'divx',
]);

// Formats whose text we extract before comparing.
const EXTRACTORS = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
};

function extOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

/**
 * Returns one of: 'image', 'video', 'pdf', 'docx', 'xlsx', 'auto'.
 * 'auto' means: read the bytes and decide between text and binary.
 */
function classify(file) {
  const ext = extOf(file);
  // .ts is usually TypeScript source in practice, not a video stream.
  if (ext === 'ts') return 'auto';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return EXTRACTORS[ext] || 'auto';
}

module.exports = { classify, extOf, IMAGE_EXT, VIDEO_EXT };
