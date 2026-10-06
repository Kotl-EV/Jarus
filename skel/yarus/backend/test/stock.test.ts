import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { applyMove, availableGood, explodeBundle, runStockTx, STOCK } from '../src/stock.engine';

const prisma = new PrismaClient();

async function setup() {
  const tenant = await prisma.tenant.create({ data: { slug: 't' + Date.now(), name: 'T' } });
  const client = await prisma.client.create({ data: { tenantId: tenant.id, name: 'C' } });
  const wh = await prisma.warehouse.create({ data: { tenantId: tenant.id, name: 'W', code: 'W' } });
  const a = await prisma.cell.create({ data: { tenantId: tenant.id, warehouseId: wh.id, code: 'A' } });
  const b = await prisma.cell.create({ data: { tenantId: tenant.id, warehouseId: wh.id, code: 'B' } });
  const p = await prisma.product.create({
    data: { tenantId: tenant.id, clientId: client.id, name: 'P', sku: 'P1', volumeCm3: 1000 },
  });
  return { tenant, client, wh, a, b, p };
}

test('остаток не уходит в минус без права', async () => {
  const s = await setup();
  await applyMove(prisma, {
    tenantId: s.tenant.id,
    type: 'receipt',
    productId: s.p.id,
    clientId: s.client.id,
    qty: 5,
    warehouseId: s.wh.id,
    to: { cellId: s.a.id, stockType: STOCK.GOOD },
  });
  await assert.rejects(
    () =>
      applyMove(prisma, {
        tenantId: s.tenant.id,
        type: 'shipment',
        productId: s.p.id,
        clientId: s.client.id,
        qty: 9,
        warehouseId: s.wh.id,
        from: { cellId: s.a.id, stockType: STOCK.GOOD },
      }),
    /Недостаточно остатка/,
  );
  const qty = await availableGood(prisma, {
    tenantId: s.tenant.id,
    productId: s.p.id,
    clientId: s.client.id,
  });
  assert.equal(qty, 5);
});

test('резерв FBS и возврат резерва', async () => {
  const s = await setup();
  await applyMove(prisma, {
    tenantId: s.tenant.id,
    type: 'receipt',
    productId: s.p.id,
    clientId: s.client.id,
    qty: 10,
    warehouseId: s.wh.id,
    to: { cellId: s.a.id, stockType: STOCK.GOOD },
  });
  await applyMove(prisma, {
    tenantId: s.tenant.id,
    type: 'reserve',
    productId: s.p.id,
    clientId: s.client.id,
    qty: 3,
    warehouseId: s.wh.id,
    from: { cellId: s.a.id, stockType: STOCK.GOOD },
    to: { cellId: s.b.id, stockType: STOCK.RESERVE_FBS },
    document: 'ORD-1',
  });
  assert.equal(
    await availableGood(prisma, { tenantId: s.tenant.id, productId: s.p.id, clientId: s.client.id }),
    7,
  );
  await applyMove(prisma, {
    tenantId: s.tenant.id,
    type: 'unreserve',
    productId: s.p.id,
    clientId: s.client.id,
    qty: 3,
    warehouseId: s.wh.id,
    from: { cellId: s.b.id, stockType: STOCK.RESERVE_FBS },
    to: { cellId: s.a.id, stockType: STOCK.GOOD },
    document: 'ORD-1',
  });
  assert.equal(
    await availableGood(prisma, { tenantId: s.tenant.id, productId: s.p.id, clientId: s.client.id }),
    10,
  );
});

test('комплект взрывается в компоненты', async () => {
  const s = await setup();
  const c1 = await prisma.product.create({
    data: { tenantId: s.tenant.id, clientId: s.client.id, name: 'C1', sku: 'C1' },
  });
  const kit = await prisma.product.create({
    data: { tenantId: s.tenant.id, clientId: s.client.id, name: 'KIT', sku: 'KIT' },
  });
  await prisma.bundleItem.create({
    data: { tenantId: s.tenant.id, bundleId: kit.id, componentId: c1.id, qty: 2 },
  });
  const parts = await explodeBundle(prisma, s.tenant.id, kit.id);
  assert.deepEqual(parts, [{ productId: c1.id, qty: 2 }]);
});

test('хранение: объём × ставка даёт сумму дня', async () => {
  const s = await setup();
  await applyMove(prisma, {
    tenantId: s.tenant.id,
    type: 'receipt',
    productId: s.p.id,
    clientId: s.client.id,
    qty: 10,
    warehouseId: s.wh.id,
    to: { cellId: s.a.id, stockType: STOCK.GOOD },
  });
  const bals = await prisma.stockBalance.findMany({
    where: { tenantId: s.tenant.id, clientId: s.client.id },
    include: { product: true },
  });
  const volume = bals.reduce((sum, b) => sum + (b.product.volumeCm3 || 0) * b.qty, 0);
  const rateKop = 150;
  const amount = Math.round((volume / 1_000_000) * rateKop);
  assert.equal(volume, 10000);
  assert.equal(amount, Math.round((10000 / 1_000_000) * 150));
});

test('вебхук идемпотентен по ключу', async () => {
  const tenant = await prisma.tenant.create({ data: { slug: 'wh' + Date.now(), name: 'W' } });
  await prisma.webhook.create({
    data: {
      tenantId: tenant.id,
      idempotency: 'k1',
      source: 'ozon',
      path: '/api/webhooks/fbs',
      payload: '{}',
    },
  });
  const second = prisma.webhook.create({
    data: {
      tenantId: tenant.id,
      idempotency: 'k1',
      source: 'ozon',
      path: '/api/webhooks/fbs',
      payload: '{}',
    },
  });
  await assert.rejects(second);
});

test('два одновременных списания одной штуки: один успех, минуса нет', async () => {
  const s = await setup();
  await applyMove(prisma, {
    tenantId: s.tenant.id,
    type: 'receipt',
    productId: s.p.id,
    clientId: s.client.id,
    qty: 1,
    warehouseId: s.wh.id,
    to: { cellId: s.a.id, stockType: STOCK.GOOD },
  });
  const ship = () =>
    applyMove(prisma, {
      tenantId: s.tenant.id,
      type: 'shipment',
      productId: s.p.id,
      clientId: s.client.id,
      qty: 1,
      warehouseId: s.wh.id,
      from: { cellId: s.a.id, stockType: STOCK.GOOD },
    });
  const results = await Promise.allSettled([ship(), ship()]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const bad = results.filter((r) => r.status === 'rejected').length;
  assert.equal(ok, 1);
  assert.equal(bad, 1);
  assert.equal(await availableGood(prisma, { tenantId: s.tenant.id, productId: s.p.id, clientId: s.client.id }), 0);
});
