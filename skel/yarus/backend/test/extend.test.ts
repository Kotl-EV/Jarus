import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { applyMove, STOCK } from '../src/stock.engine';

const prisma = new PrismaClient();

test('тара: укладка и перемещение целиком сохраняет qty', async () => {
  const tenant = await prisma.tenant.create({ data: { slug: 'box' + Date.now(), name: 'B' } });
  const client = await prisma.client.create({ data: { tenantId: tenant.id, name: 'C' } });
  const wh = await prisma.warehouse.create({ data: { tenantId: tenant.id, name: 'W', code: 'W' } });
  const a = await prisma.cell.create({ data: { tenantId: tenant.id, warehouseId: wh.id, code: 'A' } });
  const b = await prisma.cell.create({ data: { tenantId: tenant.id, warehouseId: wh.id, code: 'B' } });
  const p = await prisma.product.create({ data: { tenantId: tenant.id, clientId: client.id, name: 'P', sku: 'PX' } });
  await applyMove(prisma, {
    tenantId: tenant.id,
    type: 'receipt',
    productId: p.id,
    clientId: client.id,
    qty: 8,
    warehouseId: wh.id,
    to: { cellId: a.id, stockType: STOCK.GOOD },
  });
  const box = await prisma.container.create({ data: { tenantId: tenant.id, kind: 'box', barcode: 'BOX1', cellId: a.id } });
  await applyMove(prisma, {
    tenantId: tenant.id,
    type: 'pack',
    productId: p.id,
    clientId: client.id,
    qty: 8,
    warehouseId: wh.id,
    from: { cellId: a.id, stockType: STOCK.GOOD },
    to: { cellId: a.id, stockType: STOCK.GOOD, containerId: box.id },
  });
  await applyMove(prisma, {
    tenantId: tenant.id,
    type: 'container_move',
    productId: p.id,
    clientId: client.id,
    qty: 8,
    warehouseId: wh.id,
    from: { cellId: a.id, stockType: STOCK.GOOD, containerId: box.id },
    to: { cellId: b.id, stockType: STOCK.GOOD, containerId: box.id },
  });
  const inA = await prisma.stockBalance.findFirst({ where: { cellId: a.id, productId: p.id, containerId: box.id } });
  const inB = await prisma.stockBalance.findFirst({ where: { cellId: b.id, productId: p.id, containerId: box.id } });
  assert.equal(inA?.qty || 0, 0);
  assert.equal(inB?.qty, 8);
});
