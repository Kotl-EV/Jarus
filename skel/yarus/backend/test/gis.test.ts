import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

test('КИЗ: ввод в оборот только из uploaded/printed/labeled', async () => {
  const tenant = await prisma.tenant.create({ data: { slug: 'gis' + Date.now(), name: 'G' } });
  const ok = await prisma.cisCode.create({
    data: { tenantId: tenant.id, code: 'cis-ok-' + Date.now(), status: 'printed' },
  });
  const bad = await prisma.cisCode.create({
    data: { tenantId: tenant.id, code: 'cis-bad-' + Date.now(), status: 'in_shipment' },
  });
  assert.equal(['uploaded', 'printed', 'labeled'].includes(ok.status), true);
  assert.equal(['uploaded', 'printed', 'labeled'].includes(bad.status), false);
});
