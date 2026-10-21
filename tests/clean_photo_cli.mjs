// Runs photo.js's cleanPhoto() on a file (used by tests/photo_test.py).
//   node tests/clean_photo_cli.mjs input output
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanPhoto } from '../photo.js';

const [input, output] = process.argv.slice(2);
try {
  const result = cleanPhoto(new Uint8Array(readFileSync(input)));
  writeFileSync(output, result.bytes);
  console.log(JSON.stringify({ ok: true, type: result.type, ext: result.ext, width: result.width, height: result.height, orientation: result.orientation }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
