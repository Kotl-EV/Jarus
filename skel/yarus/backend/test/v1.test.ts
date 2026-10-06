import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

test('идемпотентность: повтор того же ключа не создаёт вторую запись', async () => {
  const tenant = await prisma.tenant.create({ data: { slug: 'idm' + Date.now(), name: 'I' } });
  await prisma.idempotencyRecord.create({
    data: { tenantId: tenant.id, key: 'same', response: '{"ok":true}' },
  });
  await assert.rejects(
    prisma.idempotencyRecord.create({
      data: { tenantId: tenant.id, key: 'same', response: '{"ok":false}' },
    }),
  );
});
