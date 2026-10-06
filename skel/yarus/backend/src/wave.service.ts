import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { applyMove, runStockTx, STOCK } from './stock.engine';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';

type Reco = { cellId: string; code: string; score: number; reason: string; qtyThere: number };

type WaveLine = {
  productId: string;
  sku: string;
  name: string;
  qty: number;
  cellId: string;
  cellCode: string;
  orderId?: string;
  picked: number;
  checked: number;
};

function fontPath() {
  return ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\ARIAL.TTF'].find((p) => fs.existsSync(p));
}

@Injectable()
export class WaveService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  async recommend(user: Authed, warehouseId: string, productId: string, qty = 1) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId: user.tenantId } });
    if (!product) throw new NotFoundException('Товар');
    const cells = await this.prisma.cell.findMany({
      where: { tenantId: user.tenantId, warehouseId, type: 'storage', blocked: false },
      include: { balances: true },
    });
    const recs: Reco[] = [];
    for (const cell of cells) {
      const here = cell.balances.filter((b) => b.qty > 0);
      const sameSku = here.filter((b) => b.productId === productId);
      const sameClient = here.filter((b) => b.clientId === product.clientId);
      const occupied = here.reduce((s, b) => s + b.qty, 0);
      const vol = here.reduce((s, b) => s + b.qty * (product.volumeCm3 || 0), 0);
      if (!cell.mixClients && here.some((b) => b.clientId !== product.clientId)) continue;
      if (cell.volumeCm3 && vol + qty * product.volumeCm3 > cell.volumeCm3) continue;
      let score = 10;
      const reasons: string[] = [];
      if (sameSku.length) {
        score += 100;
        reasons.push('тот же SKU');
      }
      if (sameClient.length) {
        score += 40;
        reasons.push('тот же клиент');
      }
      if (!here.length) {
        score += 20;
        reasons.push('пустая');
      }
      score += Math.max(0, 15 - occupied);
      recs.push({
        cellId: cell.id,
        code: cell.code,
        score,
        reason: reasons.join(', ') || 'свободный объём',
        qtyThere: sameSku.reduce((s, b) => s + b.qty, 0),
      });
    }
    recs.sort((a, b) => b.score - a.score);
    return recs.slice(0, 8);
  }

  async putaway(user: Authed, body: { warehouseId: string; productId: string; qty: number; toCellId?: string; toCellCode?: string }) {
    const product = await this.prisma.product.findFirst({ where: { id: body.productId, tenantId: user.tenantId } });
    if (!product) throw new NotFoundException('Товар');
    let to = body.toCellId
      ? await this.prisma.cell.findFirst({ where: { id: body.toCellId, tenantId: user.tenantId } })
      : null;
    if (!to && body.toCellCode) {
      to = await this.prisma.cell.findFirst({
        where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: body.toCellCode },
      });
    }
    if (!to) {
      const rec = (await this.recommend(user, body.warehouseId, body.productId, body.qty))[0];
      if (!rec) throw new BadRequestException('Нет подходящей ячейки');
      to = await this.prisma.cell.findFirst({ where: { id: rec.cellId } });
    }
    if (!to) throw new NotFoundException('Ячейка');
    const rcv = await this.prisma.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: 'RCV' } });
    const from = await this.prisma.stockBalance.findFirst({
      where: {
        tenantId: user.tenantId,
        productId: product.id,
        stockType: STOCK.GOOD,
        qty: { gte: body.qty },
        ...(rcv ? { cellId: rcv.id } : {}),
      },
    }) || await this.prisma.stockBalance.findFirst({
      where: { tenantId: user.tenantId, productId: product.id, stockType: STOCK.GOOD, qty: { gte: body.qty } },
    });
    if (!from) throw new BadRequestException('Нечего размещать');
    await runStockTx(this.prisma, (tx) =>
      applyMove(tx, {
        tenantId: user.tenantId,
        type: 'putaway',
        productId: product.id,
        clientId: product.clientId,
        qty: body.qty,
        warehouseId: body.warehouseId,
        from: { cellId: from.cellId, stockType: STOCK.GOOD, lotId: from.lotId, containerId: from.containerId },
        to: { cellId: to!.id, stockType: STOCK.GOOD, lotId: from.lotId },
        userId: user.id,
      }),
    );
    return { to: to.code, qty: body.qty };
  }

  async createWave(user: Authed, body: { warehouseId: string; orderIds?: string[] }) {
    const orders = await this.prisma.marketplaceOrder.findMany({
      where: {
        tenantId: user.tenantId,
        status: { in: ['awaiting_packaging', 'awaiting_deliver'] },
        ...(body.orderIds?.length ? { id: { in: body.orderIds } } : {}),
      },
    });
    if (!orders.length) throw new BadRequestException('Нет FBS-заказов для волны');
    const lines: WaveLine[] = [];
    for (const o of orders) {
      const payload = JSON.parse(o.payloadJson || '{}') as { products?: { offer_id?: string; sku?: string; quantity?: number }[] };
      const items = payload.products?.length
        ? payload.products
        : await this.linesFromRequest(o.requestId);
      for (const it of items) {
        const sku = String(it.offer_id || it.sku || '');
        const product = await this.prisma.product.findFirst({ where: { tenantId: user.tenantId, sku } });
        if (!product) continue;
        const bal = await this.prisma.stockBalance.findFirst({
          where: { tenantId: user.tenantId, productId: product.id, stockType: STOCK.GOOD, qty: { gt: 0 } },
          include: { cell: true },
          orderBy: { qty: 'desc' },
        });
        lines.push({
          productId: product.id,
          sku: product.sku,
          name: product.name,
          qty: it.quantity || 1,
          cellId: bal?.cellId || '',
          cellCode: bal?.cell.code || '?',
          orderId: o.id,
          picked: 0,
          checked: 0,
        });
      }
    }
    if (!lines.length) throw new BadRequestException('В заказах нет строк с известным SKU. Создайте демо-заказ FBS.');
    lines.sort((a, b) => a.cellCode.localeCompare(b.cellCode, 'ru'));
    const n = await this.prisma.pickWave.count({ where: { tenantId: user.tenantId } });
    return this.prisma.pickWave.create({
      data: {
        tenantId: user.tenantId,
        warehouseId: body.warehouseId,
        number: `W-${String(n + 1).padStart(4, '0')}`,
        status: 'open',
        orderIds: JSON.stringify(orders.map((o) => o.id)),
        linesJson: JSON.stringify(lines),
        assigneeId: user.id,
      },
    });
  }

  private async linesFromRequest(requestId?: string | null) {
    if (!requestId) return [] as { sku: string; quantity: number }[];
    const lines = await this.prisma.requestLine.findMany({ where: { requestId } });
    return lines.map((l) => ({ sku: l.sku, quantity: l.plannedQty }));
  }

  async pickWaveLine(user: Authed, waveId: string, barcode: string, qty = 1) {
    const wave = await this.getWave(user, waveId);
    const product = await this.findProduct(user.tenantId, barcode);
    const lines = JSON.parse(wave.linesJson) as WaveLine[];
    const line = lines.find((l) => l.productId === product.id && l.picked < l.qty);
    if (!line) throw new BadRequestException('SKU нет в волне или уже собран');
    const take = Math.min(qty, line.qty - line.picked);
    const ship = await this.prisma.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId: wave.warehouseId, code: 'SHP' } });
    const from = await this.prisma.stockBalance.findFirst({
      where: { tenantId: user.tenantId, productId: product.id, stockType: STOCK.GOOD, qty: { gte: take } },
    });
    if (!from || !ship) throw new BadRequestException('Нет остатка для волны');
    await runStockTx(this.prisma, (tx) =>
      applyMove(tx, {
        tenantId: user.tenantId,
        type: 'pick',
        productId: product.id,
        clientId: product.clientId,
        qty: take,
        warehouseId: wave.warehouseId,
        from: { cellId: from.cellId, stockType: STOCK.GOOD, lotId: from.lotId, containerId: from.containerId },
        to: { cellId: ship.id, stockType: STOCK.RESERVE_FBS },
        userId: user.id,
        document: wave.number,
      }),
    );
    line.picked += take;
    const status = lines.every((l) => l.picked >= l.qty) ? 'checking' : 'picking';
    await this.prisma.pickWave.update({ where: { id: wave.id }, data: { linesJson: JSON.stringify(lines), status } });
    await this.prisma.piecework.create({
      data: { tenantId: user.tenantId, userId: user.id, kind: 'pick', qty: take, rateKop: 120, amountKop: 120 * take },
    });
    return { sku: product.sku, picked: line.picked, need: line.qty, next: lines.find((l) => l.picked < l.qty)?.cellCode };
  }

  async checkWaveLine(user: Authed, waveId: string, barcode: string, qty = 1) {
    const wave = await this.getWave(user, waveId);
    const product = await this.findProduct(user.tenantId, barcode);
    const lines = JSON.parse(wave.linesJson) as WaveLine[];
    const line = lines.find((l) => l.productId === product.id && l.checked < l.picked);
    if (!line) throw new BadRequestException('Нечего проверять по этому ШК');
    line.checked = Math.min(line.picked, line.checked + qty);
    const ok = lines.every((l) => l.checked >= l.picked && l.picked >= l.qty);
    await this.prisma.pickWave.update({
      where: { id: wave.id },
      data: { linesJson: JSON.stringify(lines), status: ok ? 'ready' : 'checking' },
    });
    return { sku: product.sku, checked: line.checked, picked: line.picked, ready: ok };
  }

  async consume(user: Authed, body: { sku: string; qty: number; requestId?: string }) {
    const c = await this.prisma.consumable.findFirst({ where: { tenantId: user.tenantId, sku: body.sku } });
    if (!c) throw new NotFoundException('Расходник');
    if (c.qty < body.qty) throw new BadRequestException('Нет расходника на складе');
    await this.prisma.consumable.update({ where: { id: c.id }, data: { qty: { decrement: body.qty } } });
    if (body.requestId) {
      const req = await this.prisma.request.findFirst({ where: { id: body.requestId } });
      if (req?.clientId) {
        await this.prisma.serviceFact.create({
          data: {
            tenantId: user.tenantId,
            requestId: body.requestId,
            clientId: req.clientId,
            serviceCode: 'bag',
            qty: body.qty,
            priceKop: 150,
            amountKop: 150 * body.qty,
          },
        });
      }
    }
    return { sku: c.sku, left: c.qty - body.qty };
  }

  async pickListPdf(user: Authed, waveId: string) {
    const wave = await this.getWave(user, waveId);
    const lines = JSON.parse(wave.linesJson) as WaveLine[];
    const buf: Buffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const f = fontPath();
      if (f) doc.font(f);
      doc.fontSize(16).text('Лист подбора ' + wave.number);
      doc.fontSize(10).text('Маршрут по адресам ячеек. Статус: ' + wave.status);
      doc.moveDown();
      for (const l of lines) {
        doc.text(`${l.cellCode.padEnd(16)}  ${l.sku}  ${l.name.slice(0, 28)}  ×${l.qty}  собрано ${l.picked}  проверка ${l.checked}`);
      }
      doc.end();
    });
    return { name: `pick-${wave.number}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }

  zpl(sku: string, barcode: string, name: string) {
    const zpl = `^XA
^PW400
^FO20,20^A0N,28,28^FD${sku}^FS
^FO20,55^A0N,20,20^FD${name.slice(0, 28)}^FS
^FO20,90^BY2^BCN,60,Y,N,N^FD${barcode}^FS
^XZ`;
    return { name: `${sku}.zpl`, mime: 'text/plain', zpl, base64: Buffer.from(zpl, 'utf8').toString('base64') };
  }

  async getWave(user: Authed, id: string) {
    const w = await this.prisma.pickWave.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!w) throw new NotFoundException('Волна');
    return w;
  }

  private async findProduct(tenantId: string, code: string) {
    const bc = await this.prisma.barcode.findUnique({ where: { tenantId_code: { tenantId, code } } });
    const p = bc
      ? await this.prisma.product.findFirst({ where: { id: bc.productId } })
      : await this.prisma.product.findFirst({ where: { tenantId, sku: code } });
    if (!p) throw new NotFoundException('Штрихкод');
    return p;
  }
}
