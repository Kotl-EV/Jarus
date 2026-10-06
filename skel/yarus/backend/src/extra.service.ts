import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { notify } from './notify';
import { YarusService } from './yarus.service';
import bwipjs from 'bwip-js';

@Injectable()
export class ExtraService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(YarusService) private yarus: YarusService,
  ) {}

  async bankPay(user: Authed, body: { invoiceId: string; amountKop: number; method?: string; comment?: string }) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId: user.tenantId } });
    if (!inv) throw new NotFoundException('Счёт');
    await this.prisma.payment.create({
      data: {
        tenantId: user.tenantId,
        invoiceId: inv.id,
        clientId: inv.clientId,
        amountKop: body.amountKop,
        method: body.method || 'bank',
        comment: body.comment,
      },
    });
    const paid = await this.prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amountKop: true } });
    const sum = paid._sum.amountKop || 0;
    const status = sum >= inv.amountKop ? 'paid' : sum > 0 ? 'partial' : inv.status;
    const updated = await this.prisma.invoice.update({ where: { id: inv.id }, data: { status } });
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'bank.payment',
      title: 'Оплата ' + inv.number,
      body: `${(body.amountKop / 100).toFixed(2)} · ${status}`,
      clientId: inv.clientId,
    });
    return updated;
  }

  async bankWebhook(tenantSlug: string, idem: string, payload: Record<string, unknown>) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException('tenant');
    const existing = await this.prisma.webhook.findUnique({
      where: { tenantId_idempotency: { tenantId: tenant.id, idempotency: idem } },
    });
    if (existing) return { duplicate: true };
    const number = String(payload.invoice || payload.number || payload.purpose || '');
    const amountKop = Math.round(Number(payload.amount || payload.amountKop || 0) * (Number(payload.amountKop) ? 1 : 100));
    const inv = number
      ? await this.prisma.invoice.findFirst({ where: { tenantId: tenant.id, number } })
      : null;
    await this.prisma.webhook.create({
      data: {
        tenantId: tenant.id,
        idempotency: idem,
        source: 'bank',
        path: '/api/webhooks/bank',
        payload: JSON.stringify(payload),
      },
    });
    if (inv && amountKop) {
      await this.prisma.payment.create({
        data: {
          tenantId: tenant.id,
          invoiceId: inv.id,
          clientId: inv.clientId,
          amountKop,
          method: 'incoming',
          comment: 'bank webhook',
        },
      });
      const paid = await this.prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amountKop: true } });
      const status = (paid._sum.amountKop || 0) >= inv.amountKop ? 'paid' : 'partial';
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { status } });
    }
    return { ok: true, matched: !!inv };
  }

  async tildaWebhook(tenantSlug: string, payload: Record<string, unknown>) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException('tenant');
    const client = await this.prisma.client.findFirst({ where: { tenantId: tenant.id } });
    const type = await this.prisma.requestType.findFirst({ where: { tenantId: tenant.id, code: 'fbs' } });
    const products = (payload.products as { sku?: string; name?: string; quantity?: number; sku_id?: string }[]) || [];
    const lines = [];
    for (const p of products) {
      const sku = String(p.sku || p.sku_id || p.name || '');
      const rec = await this.prisma.product.findFirst({ where: { tenantId: tenant.id, sku } });
      if (rec) lines.push({ productId: rec.id, qty: p.quantity || 1, sku: rec.sku, name: rec.name });
    }
    const count = await this.prisma.request.count({ where: { tenantId: tenant.id } });
    const number = `TILDA-${String(count + 1).padStart(5, '0')}`;
    if (!type) return { ok: true, skipped: 'no fbs type', number };
    const req = await this.prisma.request.create({
      data: {
        tenantId: tenant.id,
        number,
        typeId: type.id,
        clientId: client?.id,
        status: 'draft',
        source: 'tilda',
        payloadJson: JSON.stringify({ email: payload.email || payload.Email, name: payload.name || payload.Name }),
        lines: {
          create: lines.map((l) => ({
            tenantId: tenant.id,
            productId: l.productId,
            sku: l.sku,
            name: l.name,
            plannedQty: l.qty,
          })),
        },
      },
    });
    await notify(this.prisma, {
      tenantId: tenant.id,
      event: 'tilda.order',
      title: 'Заявка с Tilda ' + number,
      body: String(payload.email || ''),
    });
    return { ok: true, requestId: req.id, number, lines: lines.length };
  }

  async mailing(user: Authed, body: { title: string; body: string; channel?: string; clientId?: string }) {
    const clients = body.clientId
      ? await this.prisma.client.findMany({ where: { id: body.clientId, tenantId: user.tenantId } })
      : await this.prisma.client.findMany({ where: { tenantId: user.tenantId } });
    let n = 0;
    for (const c of clients) {
      await notify(this.prisma, {
        tenantId: user.tenantId,
        event: 'mailing',
        title: body.title,
        body: body.body,
        clientId: c.id,
        channels: [body.channel || 'telegram', 'ui'],
      });
      n++;
    }
    return { sent: n };
  }

  async backupExport(user: Authed) {
    const tenantId = user.tenantId;
    const [products, stock, clients, requests, invoices, cis, cells] = await Promise.all([
      this.prisma.product.findMany({ where: { tenantId }, include: { barcodes: true } }),
      this.prisma.stockBalance.findMany({ where: { tenantId } }),
      this.prisma.client.findMany({ where: { tenantId } }),
      this.prisma.request.findMany({ where: { tenantId }, include: { lines: true } }),
      this.prisma.invoice.findMany({ where: { tenantId } }),
      this.prisma.cisCode.findMany({ where: { tenantId }, take: 5000 }),
      this.prisma.cell.findMany({ where: { tenantId } }),
    ]);
    const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tenantId, products, stock, clients, requests, invoices, cis, cells });
    return {
      name: `yarus-backup-${new Date().toISOString().slice(0, 10)}.json`,
      mime: 'application/json',
      base64: Buffer.from(json, 'utf8').toString('base64'),
    };
  }

  async setHolding(user: Authed, clientId: string, holdingId: string | null) {
    const c = await this.prisma.client.findFirst({ where: { id: clientId, tenantId: user.tenantId } });
    if (!c) throw new NotFoundException('Клиент');
    return this.prisma.client.update({ where: { id: clientId }, data: { holdingId: holdingId || null } });
  }

  async setPrices(user: Authed, clientId: string, body: { storageRateKop?: number; freeStorageDays?: number; priceMarkupPct?: number }) {
    const c = await this.prisma.client.findFirst({ where: { id: clientId, tenantId: user.tenantId } });
    if (!c) throw new NotFoundException('Клиент');
    return this.prisma.client.update({
      where: { id: clientId },
      data: {
        storageRateKop: body.storageRateKop,
        freeStorageDays: body.freeStorageDays,
        priceMarkupPct: body.priceMarkupPct,
      },
    });
  }

  async sbpQr(user: Authed, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: user.tenantId },
      include: { client: true, legalEntity: true },
    });
    if (!inv) throw new NotFoundException('Счёт');
    const le = inv.legalEntity;
    const payload = [
      'ST00012',
      `Name=${le?.name || user.tenantName}`,
      `PersonalAcc=${le?.account || '00000000000000000000'}`,
      `BankName=${le?.bankName || 'Банк'}`,
      `BIC=${le?.bik || '044525225'}`,
      `CorrespAcc=${le?.corrAccount || '30101810400000000225'}`,
      `Sum=${inv.amountKop}`,
      `Purpose=Оплата ${inv.number} ${inv.client.name}`,
    ].join('|');
    const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: payload, scale: 4, includetext: false });
    return {
      name: `sbp-${inv.number}.png`,
      mime: 'image/png',
      base64: png.toString('base64'),
      payload,
    };
  }

  async recalcInvoice(user: Authed, body: { clientId: string; periodFrom: string; periodTo: string }) {
    await this.yarus.snapshotStorage(user.tenantId);
    return this.yarus.buildInvoice(user, { ...body, kind: 'storage' });
  }

  extractCisFromPdf(base64: string) {
    const buf = Buffer.from(base64.replace(/^data:.*,/, ''), 'base64');
    const raw = buf.toString('latin1');
    const found = new Set<string>();
    const re = /01\d{14}21[0-9A-Za-z]{5,24}|\d{20,44}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) found.add(m[0]);
    const decoded = raw.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    re.lastIndex = 0;
    while ((m = re.exec(decoded))) found.add(m[0]);
    return [...found];
  }

  async importCisPdf(user: Authed, body: { base64: string; productId?: string }) {
    const codes = this.extractCisFromPdf(body.base64);
    if (!codes.length) throw new BadRequestException('В PDF не найдены коды КИЗ');
    return this.yarus.importCis(user, codes, body.productId);
  }

  async bindMpBarcode(user: Authed, barcode: string, articleMp: string) {
    const bc = await this.prisma.barcode.findUnique({
      where: { tenantId_code: { tenantId: user.tenantId, code: barcode } },
    });
    if (!bc) throw new NotFoundException('Штрихкод');
    return this.prisma.product.update({ where: { id: bc.productId }, data: { articleMp } });
  }

  async telegramInvoice(user: Authed, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: user.tenantId },
      include: { client: true },
    });
    if (!inv) throw new NotFoundException('Счёт');
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'invoice.telegram',
      title: 'Документ ' + inv.number,
      body: `Счёт на ${(inv.amountKop / 100).toFixed(2)} ${inv.currency}. Статус: ${inv.status}`,
      clientId: inv.clientId,
      channels: ['telegram', 'ui'],
    });
    return { ok: true };
  }

  async backupRestore(user: Authed, payload: { products?: any[]; clients?: any[] }) {
    const clients = await this.prisma.client.findMany({ where: { tenantId: user.tenantId } });
    const byName = new Map(clients.map((c) => [c.name, c.id]));
    let restored = 0;
    let skipped = 0;
    for (const src of payload.clients || []) {
      if (byName.has(src.name)) continue;
      const c = await this.prisma.client.create({
        data: { tenantId: user.tenantId, name: src.name, inn: src.inn, storageRateKop: src.storageRateKop || 150 },
      });
      byName.set(c.name, c.id);
    }
    const fallback = clients[0]?.id || [...byName.values()][0];
    for (const p of payload.products || []) {
      const clientId = byName.get(p.client?.name) || fallback;
      if (!clientId || !p.sku) {
        skipped++;
        continue;
      }
      const exists = await this.prisma.product.findFirst({ where: { tenantId: user.tenantId, sku: p.sku, clientId } });
      if (exists) {
        skipped++;
        continue;
      }
      const rec = await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          clientId,
          sku: p.sku,
          name: p.name || p.sku,
          weightG: p.weightG || 0,
          volumeCm3: p.volumeCm3 || 0,
          requiresCis: !!p.requiresCis,
        },
      });
      for (const b of p.barcodes || []) {
        if (!b.code) continue;
        await this.prisma.barcode.create({ data: { tenantId: user.tenantId, productId: rec.id, code: b.code } }).catch(() => undefined);
      }
      restored++;
    }
    return { restored, skipped };
  }

  async upsertConsumable(user: Authed, body: { id?: string; name: string; sku: string; qty?: number; costKop?: number }) {
    if (body.id) {
      return this.prisma.consumable.update({
        where: { id: body.id },
        data: { name: body.name, sku: body.sku, qty: body.qty, costKop: body.costKop },
      });
    }
    return this.prisma.consumable.create({
      data: { tenantId: user.tenantId, name: body.name, sku: body.sku, qty: body.qty || 0, costKop: body.costKop || 0 },
    });
  }

  async quality(user: Authed) {
    const picks = await this.prisma.piecework.aggregate({ where: { tenantId: user.tenantId, kind: 'pick' }, _sum: { qty: true } });
    const acc = await this.prisma.piecework.aggregate({ where: { tenantId: user.tenantId, kind: 'acceptance' }, _sum: { qty: true } });
    const defects = await this.prisma.stockMove.aggregate({ where: { tenantId: user.tenantId, type: 'defect' }, _sum: { qty: true } });
    const pickQty = picks._sum.qty || 0;
    const accQty = acc._sum.qty || 0;
    const defQty = defects._sum.qty || 0;
    return {
      pickQty,
      accQty,
      defQty,
      defectPct: accQty ? Math.round((defQty / accQty) * 1000) / 10 : 0,
    };
  }
}
