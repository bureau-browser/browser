import { describe, expect, test } from '@jest/globals';
import { imageSize } from '../../lib/image-size.js';

test('reads PNG dimensions from IHDR', () => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(375, 16);
  buffer.writeUInt32BE(667, 20);
  expect(imageSize(buffer)).toEqual({ width: 375, height: 667 });
});

test('returns null for unknown bytes', () => {
  expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
});
