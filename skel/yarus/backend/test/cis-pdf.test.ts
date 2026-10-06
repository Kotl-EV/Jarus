import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtraService } from '../src/extra.service';

test('из PDF-потока вытаскиваются КИЗ', () => {
  const fake = Buffer.from('%PDF-1.4\n010460406000001221ABCDEF extra 12345678901234567890\n%%EOF').toString('base64');
  const svc = Object.create(ExtraService.prototype) as ExtraService;
  const codes = svc.extractCisFromPdf(fake);
  assert.ok(codes.some((c) => c.startsWith('010460406000001221')));
  assert.ok(codes.some((c) => c.includes('12345678901234567890')));
});
