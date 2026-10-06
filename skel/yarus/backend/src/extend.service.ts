import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { applyMove, runStockTx, STOCK } from './stock.engine';
import { isClient } from './permissions';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import * as fs from 'fs';
import * as path from 'path';

function fontPath() {
  const list = [
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\ARIAL.TTF',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  return list.find((p) => fs.existsSync(p));
}

function pdfBuffer(
  draw: (doc: PDFKit.PDFDocument) => void | Promise<void>,
  size: string | [number, number] = 'A4',
  margin = 48,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size, margin });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const font = fontPath();
    if (font) doc.font(font);
    Promise.resolve(draw(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

async function codePng(text: string, bcid: string) {
  return bwipjs.toBuffer({ bcid, text: text.slice(0, 64) || '0', scale: 3, height: bcid === 'datamatrix' ? 16 : 12, includetext: bcid !== 'datamatrix' });
}

@Injectable()
export class ExtendService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  async importProducts(user: Authed, body: { clientId?: string; base64?: string; rows?: Record<string, string>[] }) {
    const clientId = isClient(user.role) ? user.clientId! : String(body.clientId || '');
    if (!clientId) throw new BadRequestException('Укажите клиента');
    let rows = body.rows || [];
    if (body.base64) rows = await this.xlsxRows(body.base64);
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const sku = String(r.sku || r.SKU || r.артикул || r['Артикул'] || '').trim();
      const name = String(r.name || r.Название || r['Название'] || r['Товар'] || '').trim();
      if (!sku || !name) continue;
      const barcode = String(r.barcode || r.ШК || r['Штрихкод'] || '').trim();
      const exists = await this.prisma.product.findFirst({ where: { tenantId: user.tenantId, clientId, sku } });
      const dims = {
        weightG: Number(r.weightG || r.Вес || 0),
        lengthMm: Number(r.lengthMm || r.Длина || 0),
        widthMm: Number(r.widthMm || r.Ширина || 0),
        heightMm: Number(r.heightMm || r.Высота || 0),
        requiresCis: ['1', 'true', 'да', 'yes'].includes(String(r.requiresCis || r.ЧЗ || '').toLowerCase()),
      };
      const volumeCm3 = Math.round((dims.widthMm * dims.heightMm * dims.lengthMm) / 1000);
      if (exists) {
        await this.prisma.product.update({ where: { id: exists.id }, data: { name, ...dims, volumeCm3 } });
        updated++;
        if (barcode) {
          await this.prisma.barcode.upsert({
            where: { tenantId_code: { tenantId: user.tenantId, code: barcode } },
            create: { tenantId: user.tenantId, productId: exists.id, code: barcode },
            update: {},
          });
        }
      } else {
        const p = await this.prisma.product.create({
          data: { tenantId: user.tenantId, clientId, sku, name, ...dims, volumeCm3 },
        });
        if (barcode) {
          await this.prisma.barcode.create({ data: { tenantId: user.tenantId, productId: p.id, code: barcode } }).catch(() => undefined);
        }
        created++;
      }
    }
    return { created, updated, total: rows.length };
  }

  async importRequests(user: Authed, body: { typeCode: string; clientId?: string; warehouseId?: string; base64?: string; rows?: { sku: string; qty: number }[] }) {
    let rows = body.rows || [];
    if (body.base64) {
      const parsed = await this.xlsxRows(body.base64);
      rows = parsed.map((r) => ({
        sku: String(r.sku || r.SKU || r.артикул || r['Артикул'] || ''),
        qty: Number(r.qty || r.qty || r.Колво || r['Кол-во'] || r.Количество || 0),
      }));
    }
    const lines = [];
    for (const r of rows) {
      if (!r.sku || !r.qty) continue;
      const p = await this.prisma.product.findFirst({
        where: {
          tenantId: user.tenantId,
          sku: r.sku.trim(),
          ...(isClient(user.role) ? { clientId: user.clientId || undefined } : body.clientId ? { clientId: body.clientId } : {}),
        },
      });
      if (p) lines.push({ productId: p.id, qty: r.qty, sku: p.sku, name: p.name });
    }
    return { lines, typeCode: body.typeCode, clientId: body.clientId, warehouseId: body.warehouseId };
  }

  async xlsxRows(base64: string): Promise<Record<string, string>[]> {
    const buf = Buffer.from(base64.replace(/^data:.*,/, ''), 'base64');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const sheet = wb.worksheets[0];
    if (!sheet) return [];
    const header: string[] = [];
    sheet.getRow(1).eachCell((c, i) => {
      header[i] = String(c.value || '').trim();
    });
    const rows: Record<string, string>[] = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const obj: Record<string, string> = {};
      row.eachCell((c, i) => {
        obj[header[i] || `c${i}`] = String(c.value ?? '');
        const key = (header[i] || '').toLowerCase();
        if (key) obj[key] = String(c.value ?? '');
      });
      rows.push(obj);
    });
    return rows;
  }

  async exportExcel(user: Authed, kind: 'products' | 'stock' | 'cis' | 'requests' | 'storage') {
    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet(kind);
    if (kind === 'products') {
      sh.addRow(['sku', 'name', 'barcode', 'client', 'weightG', 'lengthMm', 'widthMm', 'heightMm', 'requiresCis']);
      const rows = await this.prisma.product.findMany({
        where: { tenantId: user.tenantId, archived: false, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
        include: { barcodes: true, client: true },
      });
      for (const p of rows) sh.addRow([p.sku, p.name, p.barcodes[0]?.code, p.client.name, p.weightG, p.lengthMm, p.widthMm, p.heightMm, p.requiresCis ? 1 : 0]);
    }
    if (kind === 'stock') {
      sh.addRow(['sku', 'name', 'client', 'cell', 'type', 'qty']);
      const rows = await this.prisma.stockBalance.findMany({
        where: { tenantId: user.tenantId, qty: { not: 0 } },
        include: { product: true, client: true, cell: true },
      });
      for (const s of rows) sh.addRow([s.product.sku, s.product.name, s.client.name, s.cell.code, s.stockType, s.qty]);
    }
    if (kind === 'cis') {
      sh.addRow(['code', 'status', 'sku', 'printCopies']);
      const rows = await this.prisma.cisCode.findMany({ where: { tenantId: user.tenantId }, include: { product: true }, take: 5000 });
      for (const c of rows) sh.addRow([c.code, c.status, c.product?.sku, c.printCopies]);
    }
    if (kind === 'storage') {
      sh.addRow(['date', 'clientId', 'volumeCm3', 'amountKop']);
      const rows = await this.prisma.storageDaily.findMany({ where: { tenantId: user.tenantId }, orderBy: { date: 'desc' }, take: 365 });
      for (const d of rows) sh.addRow([d.date, d.clientId, d.volumeCm3, d.amountKop]);
    }
    if (kind === 'requests') {
      sh.addRow(['number', 'type', 'status', 'client', 'stage']);
      const rows = await this.prisma.request.findMany({ where: { tenantId: user.tenantId }, include: { type: true, client: true } });
      for (const r of rows) sh.addRow([r.number, r.type.name, r.status, r.client?.name, r.currentStageKey]);
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return { name: `yarus-${kind}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: buf.toString('base64') };
  }

  async labelPdf(user: Authed, body: { productId?: string; cisId?: string; kind?: string; copies?: number }) {
    const copies = Math.min(body.copies || 1, 50);
    const product = body.productId
      ? await this.prisma.product.findFirst({ where: { id: body.productId, tenantId: user.tenantId }, include: { barcodes: true } })
      : null;
    const cis = body.cisId ? await this.prisma.cisCode.findFirst({ where: { id: body.cisId, tenantId: user.tenantId } }) : null;
    const sku = product?.sku || 'SKU';
    const name = product?.name || 'Товар';
    const barcode = product?.barcodes[0]?.code || sku;
    const kiz = cis?.code || '';
    const png = await codePng(kiz || barcode, kiz ? 'datamatrix' : 'code128');
    const buf = await pdfBuffer(async (doc) => {
      for (let i = 0; i < copies; i++) {
        if (i) doc.addPage({ size: [164, 113], margin: 8 });
        doc.fontSize(9).text(sku, 10, 8);
        doc.fontSize(8).text(name.slice(0, 42), 10, 22, { width: 140 });
        doc.image(png, 10, 40, { width: kiz ? 48 : 140, height: 48 });
        if (kiz) doc.fontSize(6).text(kiz.slice(0, 28), 62, 44, { width: 90 });
        doc.fontSize(7).text(barcode, 10, 96);
      }
    }, [164, 113], 8);
    await this.prisma.printJob.create({ data: { tenantId: user.tenantId, status: 'done', copies } });
    return { name: `label-${sku}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }

  async invoicePdf(user: Authed, id: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, tenantId: user.tenantId }, include: { client: true, legalEntity: true } });
    if (!inv) throw new NotFoundException('Счёт');
    const lines = JSON.parse(inv.linesJson || '[]') as { title: string; amountKop: number }[];
    const buf = await pdfBuffer((doc) => {
      doc.fontSize(16).text('Счёт ' + inv.number);
      doc.moveDown(0.3);
      doc.fontSize(10).text(inv.legalEntity?.name || 'Ярус');
      doc.text('Клиент: ' + inv.client.name);
      doc.text('Статус: ' + inv.status);
      doc.moveDown();
      for (const l of lines) doc.text(`${l.title} — ${(l.amountKop / 100).toFixed(2)} ${inv.currency}`);
      doc.moveDown();
      doc.fontSize(12).text('Итого: ' + (inv.amountKop / 100).toFixed(2) + ' ' + inv.currency);
    });
    return { name: `${inv.number}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }

  async quotePdf(user: Authed, body: { items: { serviceCode: string; qty: number }[]; clientId?: string }) {
    const services = await this.prisma.service.findMany({ where: { tenantId: user.tenantId } });
    const map = new Map(services.map((s) => [s.code, s]));
    const lines = body.items.map((i) => {
      const s = map.get(i.serviceCode);
      const amount = Math.round((s?.priceKop || 0) * i.qty);
      return { title: s?.name || i.serviceCode, qty: i.qty, amountKop: amount };
    });
    const total = lines.reduce((s, l) => s + l.amountKop, 0);
    const buf = await pdfBuffer((doc) => {
      doc.fontSize(16).text('Коммерческое предложение');
      doc.moveDown();
      for (const l of lines) doc.fontSize(10).text(`${l.title} × ${l.qty} — ${(l.amountKop / 100).toFixed(2)}`);
      doc.moveDown();
      doc.fontSize(12).text('Итого: ' + (total / 100).toFixed(2) + ' ' + user.currency);
    });
    return { name: 'kp.pdf', mime: 'application/pdf', base64: buf.toString('base64'), totalKop: total };
  }

  async actPdf(user: Authed, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: user.tenantId }, include: { client: true, legalEntity: true } });
    if (!inv) throw new NotFoundException('Счёт');
    const buf = await pdfBuffer((doc) => {
      doc.fontSize(16).text('Акт выполненных работ к ' + inv.number);
      doc.moveDown();
      doc.fontSize(10).text(inv.legalEntity?.name || '');
      doc.text('Заказчик: ' + inv.client.name);
      doc.text('Сумма: ' + (inv.amountKop / 100).toFixed(2) + ' ' + inv.currency);
      doc.moveDown(2);
      doc.text('Исполнитель ________________    Заказчик ________________');
      if (inv.legalEntity?.facsimileUrl) doc.moveDown().fontSize(8).text('Факсимиле: ' + inv.legalEntity.facsimileUrl);
    });
    return { name: `act-${inv.number}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }

  async packingListPdf(user: Authed, requestId: string) {
    const req = await this.prisma.request.findFirst({
      where: { id: requestId, tenantId: user.tenantId },
      include: { lines: true, client: true },
    });
    if (!req) throw new NotFoundException('Заявка');
    const boxes = await this.prisma.container.findMany({ where: { tenantId: user.tenantId, status: { not: 'closed' } } });
    const buf = await pdfBuffer(async (doc) => {
      doc.fontSize(16).text('Паллетный / коробочный лист ' + req.number);
      doc.fontSize(10).text('Клиент: ' + (req.client?.name || ''));
      doc.text('QR поставки: ' + (req.mpShipmentId || req.number));
      try {
        const qr = await codePng(req.mpShipmentId || req.number, 'qrcode');
        doc.image(qr, 400, 48, { width: 90 });
      } catch {
        /* qr optional */
      }
      doc.moveDown(2);
      for (const l of req.lines) doc.text(`${l.sku}  ${l.name}  план ${l.plannedQty}  факт ${l.factQty}  брак ${l.defectQty}`);
      doc.moveDown();
      doc.text('Короба: ' + boxes.map((b) => b.barcode).join(', '));
    });
    return { name: `fbo-${req.number}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }

  async inventoryActPdf(user: Authed, requestId: string) {
    const req = await this.prisma.request.findFirst({ where: { id: requestId, tenantId: user.tenantId }, include: { lines: true } });
    if (!req) throw new NotFoundException('Заявка');
    const payload = JSON.parse(req.payloadJson || '{}') as { diffs?: { sku?: string; delta: number; cell?: string }[] };
    const buf = await pdfBuffer((doc) => {
      doc.fontSize(16).text('Акт инвентаризации ' + req.number);
      doc.moveDown();
      for (const d of payload.diffs || []) doc.fontSize(10).text(`${d.sku || ''}  ${d.cell || ''}  Δ ${d.delta}`);
      if (!(payload.diffs || []).length) {
        for (const l of req.lines) doc.fontSize(10).text(`${l.sku} план ${l.plannedQty} факт ${l.factQty} Δ ${l.factQty - l.plannedQty}`);
      }
    });
    return { name: `inv-${req.number}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }

  async createContainer(user: Authed, body: { kind: string; barcode?: string; cellId?: string; clientId?: string; capacity?: number }) {
    const barcode = body.barcode || 'BOX-' + Date.now().toString(36).toUpperCase();
    return this.prisma.container.create({
      data: {
        tenantId: user.tenantId,
        kind: body.kind || 'box',
        barcode,
        cellId: body.cellId,
        clientId: isClient(user.role) ? user.clientId : body.clientId,
        capacity: body.capacity || 0,
      },
    });
  }

  async packContainer(user: Authed, id: string, body: { productId: string; qty: number; warehouseId: string; fromCellId?: string }) {
    const box = await this.prisma.container.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!box) throw new NotFoundException('Тара');
    const p = await this.prisma.product.findFirst({ where: { id: body.productId, tenantId: user.tenantId } });
    if (!p) throw new NotFoundException('Товар');
    const from = body.fromCellId
      ? await this.prisma.stockBalance.findFirst({ where: { tenantId: user.tenantId, productId: p.id, cellId: body.fromCellId, stockType: STOCK.GOOD, qty: { gte: body.qty } } })
      : await this.prisma.stockBalance.findFirst({ where: { tenantId: user.tenantId, productId: p.id, stockType: STOCK.GOOD, qty: { gte: body.qty } } });
    if (!from) throw new BadRequestException('Нет остатка для укладки в тару');
    const destCell = box.cellId || from.cellId;
    await runStockTx(this.prisma, (tx) =>
      applyMove(tx, {
        tenantId: user.tenantId,
        type: 'pack',
        productId: p.id,
        clientId: p.clientId,
        qty: body.qty,
        warehouseId: body.warehouseId,
        from: { cellId: from.cellId, stockType: STOCK.GOOD, lotId: from.lotId, containerId: from.containerId },
        to: { cellId: destCell, stockType: STOCK.GOOD, containerId: box.id },
        userId: user.id,
        document: box.barcode,
      }),
    );
    return { ok: true, barcode: box.barcode };
  }

  async moveContainer(user: Authed, id: string, body: { cellId: string; warehouseId: string }) {
    const box = await this.prisma.container.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!box) throw new NotFoundException('Тара');
    const bals = await this.prisma.stockBalance.findMany({ where: { tenantId: user.tenantId, containerId: box.id, qty: { gt: 0 } } });
    await runStockTx(this.prisma, async (tx) => {
      for (const b of bals) {
        await applyMove(tx, {
          tenantId: user.tenantId,
          type: 'container_move',
          productId: b.productId,
          clientId: b.clientId,
          qty: b.qty,
          warehouseId: body.warehouseId,
          from: { cellId: b.cellId, stockType: b.stockType, lotId: b.lotId, containerId: box.id },
          to: { cellId: body.cellId, stockType: b.stockType, lotId: b.lotId, containerId: box.id },
          userId: user.id,
          document: box.barcode,
        });
      }
      await tx.container.update({ where: { id: box.id }, data: { cellId: body.cellId } });
    });
    return { moved: bals.length };
  }

  async unpackContainer(user: Authed, id: string, body: { warehouseId: string; cellId?: string }) {
    const box = await this.prisma.container.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!box) throw new NotFoundException('Тара');
    const dest = body.cellId || box.cellId;
    if (!dest) throw new BadRequestException('Нет ячейки');
    const bals = await this.prisma.stockBalance.findMany({ where: { tenantId: user.tenantId, containerId: box.id, qty: { gt: 0 } } });
    await runStockTx(this.prisma, async (tx) => {
      for (const b of bals) {
        await applyMove(tx, {
          tenantId: user.tenantId,
          type: 'unpack',
          productId: b.productId,
          clientId: b.clientId,
          qty: b.qty,
          warehouseId: body.warehouseId,
          from: { cellId: b.cellId, stockType: b.stockType, lotId: b.lotId, containerId: box.id },
          to: { cellId: dest, stockType: b.stockType, lotId: b.lotId, containerId: '' },
          userId: user.id,
        });
      }
      await tx.container.update({ where: { id }, data: { status: 'empty' } });
    });
    return { unpacked: bals.length };
  }

  async decideReturn(user: Authed, body: {
    productId: string;
    qty: number;
    warehouseId: string;
    decision: 'good' | 'defect' | 'util';
    source?: string;
    orderId?: string;
    requestId?: string;
  }) {
    const p = await this.prisma.product.findFirst({ where: { id: body.productId, tenantId: user.tenantId } });
    if (!p) throw new NotFoundException('Товар');
    const rcv = await this.prisma.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: 'RCV' } });
    const def = await this.prisma.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: 'DEF' } });
    if (!rcv || !def) throw new NotFoundException('Служебные ячейки');
    if (body.decision === 'util') {
      const from = await this.prisma.stockBalance.findFirst({
        where: { tenantId: user.tenantId, productId: p.id, stockType: { in: [STOCK.GOOD, STOCK.QUARANTINE, STOCK.DEFECT] }, qty: { gte: body.qty } },
      });
      if (from) {
        await runStockTx(this.prisma, (tx) =>
          applyMove(tx, {
            tenantId: user.tenantId,
            type: 'writeoff',
            productId: p.id,
            clientId: p.clientId,
            qty: body.qty,
            warehouseId: body.warehouseId,
            from: { cellId: from.cellId, stockType: from.stockType, lotId: from.lotId, containerId: from.containerId },
            requestId: body.requestId,
            userId: user.id,
            document: 'return-util',
          }),
        );
      }
    } else {
      const stockType = body.decision === 'defect' ? STOCK.DEFECT : STOCK.GOOD;
      const cellId = body.decision === 'defect' ? def.id : rcv.id;
      await runStockTx(this.prisma, (tx) =>
        applyMove(tx, {
          tenantId: user.tenantId,
          type: 'return',
          productId: p.id,
          clientId: p.clientId,
          qty: body.qty,
          warehouseId: body.warehouseId,
          to: { cellId, stockType },
          requestId: body.requestId,
          userId: user.id,
          document: body.orderId || body.source || 'return',
        }),
      );
    }
    if (body.requestId) {
      await this.prisma.serviceFact.create({
        data: {
          tenantId: user.tenantId,
          requestId: body.requestId,
          clientId: p.clientId,
          serviceCode: 'defect_check',
          qty: body.qty,
          priceKop: 600,
          amountKop: 600 * body.qty,
        },
      });
    }
    return { ok: true, decision: body.decision };
  }

  async startInventory(user: Authed, body: { warehouseId: string; zoneId?: string }) {
    const type = await this.prisma.requestType.findFirst({ where: { tenantId: user.tenantId, code: 'inventory' } });
    if (!type) throw new NotFoundException('Тип инвентаризации');
    if (body.zoneId) {
      await this.prisma.cell.updateMany({ where: { tenantId: user.tenantId, zoneId: body.zoneId }, data: { blocked: true } });
    }
    const count = await this.prisma.request.count({ where: { tenantId: user.tenantId } });
    const number = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
    const bals = await this.prisma.stockBalance.findMany({
      where: { tenantId: user.tenantId, warehouseId: body.warehouseId, stockType: STOCK.GOOD, qty: { not: 0 } },
      include: { product: true, cell: true },
    });
    const req = await this.prisma.request.create({
      data: {
        tenantId: user.tenantId,
        number,
        typeId: type.id,
        warehouseId: body.warehouseId,
        status: 'in_progress',
        locked: true,
        currentStageKey: 'count',
        payloadJson: JSON.stringify({ zoneId: body.zoneId, plan: bals.map((b) => ({ productId: b.productId, sku: b.product.sku, cellId: b.cellId, cell: b.cell.code, qty: b.qty })) }),
        lines: {
          create: bals.map((b) => ({
            tenantId: user.tenantId,
            productId: b.productId,
            sku: b.product.sku,
            name: b.product.name,
            plannedQty: b.qty,
          })),
        },
      },
    });
    return req;
  }

  async inventoryCount(user: Authed, body: { requestId: string; barcode: string; qty: number; cellCode?: string }) {
    const req = await this.prisma.request.findFirst({ where: { id: body.requestId, tenantId: user.tenantId } });
    if (!req) throw new NotFoundException('Инвентаризация');
    const bc = await this.prisma.barcode.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: body.barcode } } });
    const product = bc
      ? await this.prisma.product.findFirst({ where: { id: bc.productId } })
      : await this.prisma.product.findFirst({ where: { tenantId: user.tenantId, sku: body.barcode } });
    if (!product) throw new NotFoundException('Штрихкод');
    await this.prisma.requestLine.updateMany({
      where: { requestId: req.id, productId: product.id },
      data: { factQty: { increment: body.qty } },
    });
    const payload = JSON.parse(req.payloadJson || '{}');
    payload.counts = [...(payload.counts || []), { productId: product.id, sku: product.sku, qty: body.qty, cellCode: body.cellCode, at: new Date().toISOString() }];
    await this.prisma.request.update({ where: { id: req.id }, data: { payloadJson: JSON.stringify(payload) } });
    return { sku: product.sku, qty: body.qty };
  }

  async closeInventory(user: Authed, requestId: string) {
    const req = await this.prisma.request.findFirst({ where: { id: requestId, tenantId: user.tenantId }, include: { lines: true } });
    if (!req) throw new NotFoundException();
    const payload = JSON.parse(req.payloadJson || '{}');
    const diffs = req.lines.map((l) => ({
      productId: l.productId,
      sku: l.sku,
      delta: l.factQty - l.plannedQty,
      clientId: payload.plan?.find((p: { productId: string }) => p.productId === l.productId)?.clientId,
      cellId: payload.plan?.find((p: { productId: string }) => p.productId === l.productId)?.cellId,
      stockType: STOCK.GOOD,
    })).filter((d) => d.delta !== 0);
    payload.diffs = diffs;
    if (payload.zoneId) {
      await this.prisma.cell.updateMany({ where: { tenantId: user.tenantId, zoneId: payload.zoneId }, data: { blocked: false } });
    }
    await this.prisma.request.update({
      where: { id: requestId },
      data: { payloadJson: JSON.stringify(payload), currentStageKey: 'approve', status: 'in_progress' },
    });
    return { diffs, surplus: diffs.filter((d) => d.delta > 0).length, shortage: diffs.filter((d) => d.delta < 0).length };
  }

  async createLot(user: Authed, body: { productId: string; number: string; expiresAt?: string; producedAt?: string; gtd?: string }) {
    return this.prisma.lot.create({
      data: {
        tenantId: user.tenantId,
        productId: body.productId,
        number: body.number,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        producedAt: body.producedAt ? new Date(body.producedAt) : undefined,
        gtd: body.gtd,
      },
    });
  }

  async expiring(user: Authed, days = 30) {
    const until = new Date(Date.now() + days * 86400000);
    return this.prisma.lot.findMany({
      where: { tenantId: user.tenantId, expiresAt: { lte: until, not: null } },
      include: { product: true },
      orderBy: { expiresAt: 'asc' },
    });
  }

  dataDir() {
    const d = path.join(process.cwd(), '..', 'data');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}
