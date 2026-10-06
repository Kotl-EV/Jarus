import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export const STOCK = {
  GOOD: 'good',
  DEFECT: 'defect',
  QUARANTINE: 'quarantine',
  RESERVE_REQUEST: 'reserve_request',
  RESERVE_FBS: 'reserve_fbs',
  NOMINAL: 'nominal',
  IN_TRANSIT: 'in_transit',
  EXPECTED: 'expected',
} as const;

export type StockType = (typeof STOCK)[keyof typeof STOCK];

export type MoveInput = {
  tenantId: string;
  type: string;
  productId: string;
  clientId: string;
  qty: number;
  warehouseId: string;
  from?: { cellId: string; stockType: string; lotId?: string; containerId?: string };
  to?: { cellId: string; stockType: string; lotId?: string; containerId?: string };
  requestId?: string;
  document?: string;
  userId?: string;
  device?: string;
  barcode?: string;
  cis?: string;
  allowNegative?: boolean;
};

type Tx = Prisma.TransactionClient | PrismaClient;

function isRetryable(e: unknown) {
  const err = e as { code?: string; message?: string };
  const msg = String(err.message || '');
  return (
    err.code === 'P2034' ||
    err.code === 'P2002' ||
    msg.includes('40001') ||
    msg.includes('40P01') ||
    msg.includes('could not serialize') ||
    msg.includes('deadlock')
  );
}

export async function runStockTx<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 8000,
        timeout: 20000,
      });
    } catch (e) {
      last = e;
      if (!isRetryable(e) || i === 5) throw e;
      await new Promise((r) => setTimeout(r, 20 + i * 40));
    }
  }
  throw last;
}

async function bump(
  tx: Tx,
  key: {
    tenantId: string;
    warehouseId: string;
    cellId: string;
    productId: string;
    clientId: string;
    lotId: string;
    containerId: string;
    stockType: string;
  },
  delta: number,
  allowNegative: boolean,
) {
  try {
    await tx.$queryRaw`
      SELECT id FROM "StockBalance"
      WHERE "tenantId" = ${key.tenantId}
        AND "warehouseId" = ${key.warehouseId}
        AND "cellId" = ${key.cellId}
        AND "productId" = ${key.productId}
        AND "lotId" = ${key.lotId}
        AND "containerId" = ${key.containerId}
        AND "stockType" = ${key.stockType}
        AND "clientId" = ${key.clientId}
      FOR UPDATE
    `;
  } catch {
    /* SQLite has no FOR UPDATE */
  }

  const updated = await tx.stockBalance.updateMany({
    where: key,
    data: { qty: { increment: delta } },
  });
  if (updated.count === 0) {
    if (delta < 0 && !allowNegative) {
      throw new ForbiddenException('Недостаточно остатка. Минус без права запрещён.');
    }
    try {
      await tx.stockBalance.create({ data: { ...key, qty: delta } });
    } catch {
      await tx.stockBalance.updateMany({
        where: key,
        data: { qty: { increment: delta } },
      });
    }
  }

  const row = await tx.stockBalance.findUnique({
    where: {
      tenantId_warehouseId_cellId_productId_lotId_containerId_stockType_clientId: key,
    },
  });
  if ((row?.qty ?? 0) < 0 && !allowNegative) {
    throw new ForbiddenException('Недостаточно остатка. Минус без права запрещён.');
  }
  return row?.qty ?? 0;
}

function isPrismaClient(tx: Tx): tx is PrismaClient {
  return typeof (tx as PrismaClient).$transaction === 'function';
}

export async function applyMove(tx: Tx, input: MoveInput) {
  if (isPrismaClient(tx)) return runStockTx(tx, (inner) => applyMoveOn(inner, input));
  return applyMoveOn(tx, input);
}

async function applyMoveOn(tx: Tx, input: MoveInput) {
  if (input.qty <= 0) throw new BadRequestException('Количество должно быть больше нуля');
  const allow = !!input.allowNegative;
  if (input.from) {
    await bump(
      tx,
      {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        cellId: input.from.cellId,
        productId: input.productId,
        clientId: input.clientId,
        lotId: input.from.lotId || '',
        containerId: input.from.containerId || '',
        stockType: input.from.stockType,
      },
      -input.qty,
      allow,
    );
  }
  if (input.to) {
    await bump(
      tx,
      {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        cellId: input.to.cellId,
        productId: input.productId,
        clientId: input.clientId,
        lotId: input.to.lotId || '',
        containerId: input.to.containerId || '',
        stockType: input.to.stockType,
      },
      input.qty,
      true,
    );
  }
  await tx.stockMove.create({
    data: {
      tenantId: input.tenantId,
      type: input.type,
      productId: input.productId,
      clientId: input.clientId,
      qty: input.qty,
      fromCellId: input.from?.cellId,
      toCellId: input.to?.cellId,
      fromType: input.from?.stockType,
      toType: input.to?.stockType,
      lotId: input.from?.lotId || input.to?.lotId,
      containerId: input.from?.containerId || input.to?.containerId,
      requestId: input.requestId,
      document: input.document,
      userId: input.userId,
      device: input.device,
      barcode: input.barcode,
      cis: input.cis,
      warehouseId: input.warehouseId,
    },
  });
}

export async function availableGood(
  tx: Tx,
  args: {
    tenantId: string;
    warehouseId?: string;
    productId: string;
    clientId: string;
  },
) {
  const rows = await tx.stockBalance.findMany({
    where: {
      tenantId: args.tenantId,
      productId: args.productId,
      clientId: args.clientId,
      stockType: STOCK.GOOD,
      ...(args.warehouseId ? { warehouseId: args.warehouseId } : {}),
    },
  });
  return rows.reduce((s, r) => s + r.qty, 0);
}

export async function explodeBundle(
  tx: Tx,
  tenantId: string,
  productId: string,
): Promise<{ productId: string; qty: number }[]> {
  const items = await tx.bundleItem.findMany({ where: { tenantId, bundleId: productId } });
  if (!items.length) return [{ productId, qty: 1 }];
  const out: { productId: string; qty: number }[] = [];
  for (const it of items) {
    const nested = await explodeBundle(tx, tenantId, it.componentId);
    for (const n of nested) out.push({ productId: n.productId, qty: n.qty * it.qty });
  }
  return out;
}
