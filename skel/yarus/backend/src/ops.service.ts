import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { decryptSecret, encryptSecret } from './crypto-util';
import { notify } from './notify';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

const TRUE_API = 'https://markirovka.crpt.ru/api/v3/true-api';

function fontPath() {
  return ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\ARIAL.TTF'].find((p) => fs.existsSync(p));
}

function pdfBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const f = fontPath();
    if (f) doc.font(f);
    draw(doc);
    doc.end();
  });
}

type GisFlags = { gisMt?: { tokenEnc?: string; inn?: string } };

@Injectable()
export class OpsService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  private async flags(tenantId: string): Promise<GisFlags> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    try {
      return JSON.parse(t?.featureFlags || '{}') as GisFlags;
    } catch {
      return {};
    }
  }

  private async saveFlags(tenantId: string, patch: GisFlags) {
    const cur = await this.flags(tenantId);
    const next = { ...cur, ...patch, gisMt: { ...(cur.gisMt || {}), ...(patch.gisMt || {}) } };
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { featureFlags: JSON.stringify(next) } });
    return next;
  }

  async gisSettings(user: Authed, body?: { token?: string; inn?: string }) {
    if (body) {
      await this.saveFlags(user.tenantId, {
        gisMt: {
          tokenEnc: body.token ? encryptSecret(body.token) : undefined,
          inn: body.inn,
        },
      });
    }
    const f = await this.flags(user.tenantId);
    return { configured: !!f.gisMt?.tokenEnc, inn: f.gisMt?.inn || null, demo: !f.gisMt?.tokenEnc };
  }

  private async gisToken(tenantId: string) {
    const f = await this.flags(tenantId);
    return f.gisMt?.tokenEnc ? decryptSecret(f.gisMt.tokenEnc) : '';
  }

  async gisCisInfo(user: Authed, codes: string[]) {
    const token = await this.gisToken(user.tenantId);
    if (!token) {
      const local = await this.prisma.cisCode.findMany({
        where: { tenantId: user.tenantId, code: { in: codes } },
        include: { product: true },
      });
      return { demo: true, items: local };
    }
    const res = await fetch(`${TRUE_API}/cises/info`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(codes),
    });
    const remote = await res.json().catch(() => ({ status: res.status }));
    return { demo: false, remote };
  }

  async gisDocument(user: Authed, action: 'introduce' | 'ship' | 'return', ids: string[]) {
    const codes = await this.prisma.cisCode.findMany({ where: { tenantId: user.tenantId, id: { in: ids } } });
    if (!codes.length) throw new BadRequestException('Нет КИЗ');
    const next: Record<typeof action, string> = {
      introduce: 'in_circulation',
      ship: 'in_shipment',
      return: 'in_circulation',
    };
    const allowed: Record<typeof action, string[]> = {
      introduce: ['uploaded', 'printed', 'labeled'],
      ship: ['in_circulation', 'labeled', 'printed'],
      return: ['in_shipment', 'in_circulation'],
    };
    for (const c of codes) {
      if (!allowed[action].includes(c.status)) {
        throw new BadRequestException(`КИЗ ${c.code.slice(0, 12)}… статус ${c.status}, действие ${action} нельзя`);
      }
    }
    const token = await this.gisToken(user.tenantId);
    let remote: unknown = { demo: true };
    if (token) {
      const type = action === 'introduce' ? 'LP_INTRODUCE_GOODS' : action === 'ship' ? 'LP_SHIP_GOODS' : 'LP_RETURN';
      const res = await fetch(`${TRUE_API}/lk/documents/create?pg=lp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_format: 'MANUAL',
          type,
          product_document: Buffer.from(JSON.stringify({ cises: codes.map((c) => c.code) })).toString('base64'),
        }),
      });
      remote = await res.json().catch(() => ({ status: res.status }));
    }
    await this.prisma.cisCode.updateMany({
      where: { id: { in: codes.map((c) => c.id) } },
      data: { status: next[action] },
    });
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'gis_mt.' + action,
      title: 'ГИС МТ / ' + action,
      body: `${codes.length} КИЗ, режим ${token ? 'True API' : 'демо'}`,
    });
    return { ok: true, count: codes.length, status: next[action], remote };
  }

  async warehouseMap(user: Authed, warehouseId: string) {
    const cells = await this.prisma.cell.findMany({
      where: { tenantId: user.tenantId, warehouseId },
      include: { balances: { include: { product: true } }, zone: true },
      orderBy: { code: 'asc' },
    });
    return cells.map((c) => {
      const qty = c.balances.reduce((s, b) => s + b.qty, 0);
      const vol = c.balances.reduce((s, b) => s + b.qty * (b.product.volumeCm3 || 0), 0);
      const fill = c.volumeCm3 ? Math.min(100, Math.round((vol / c.volumeCm3) * 100)) : qty ? 40 : 0;
      return {
        id: c.id,
        code: c.code,
        type: c.type,
        blocked: c.blocked,
        aisle: c.aisle,
        rack: c.rack,
        shelf: c.shelf,
        zone: c.zone?.name,
        qty,
        fill,
        skuCount: c.balances.filter((b) => b.qty > 0).length,
      };
    });
  }

  async openShift(user: Authed, method = 'qr') {
    const open = await this.prisma.shift.findFirst({ where: { tenantId: user.tenantId, userId: user.id, endedAt: null } });
    if (open) return open;
    return this.prisma.shift.create({ data: { tenantId: user.tenantId, userId: user.id, method } });
  }

  async closeShift(user: Authed) {
    const open = await this.prisma.shift.findFirst({ where: { tenantId: user.tenantId, userId: user.id, endedAt: null } });
    if (!open) throw new BadRequestException('Нет открытой смены');
    return this.prisma.shift.update({ where: { id: open.id }, data: { endedAt: new Date() } });
  }

  shiftQr(user: Authed) {
    return { payload: `yarus-shift:${user.tenantId}:${user.id}`, user: user.fullName };
  }

  async scanShift(user: Authed, payload: string) {
    if (!payload.startsWith('yarus-shift:')) throw new BadRequestException('Это не QR смены');
    const parts = payload.split(':');
    if (parts[1] !== user.tenantId) throw new BadRequestException('Чужой склад');
    const open = await this.prisma.shift.findFirst({ where: { tenantId: user.tenantId, userId: user.id, endedAt: null } });
    if (open) return this.closeShift(user);
    return this.openShift(user, 'qr');
  }

  async setTracking(user: Authed, orderId: string, body: { tracking?: string; pvz?: string; status?: string }) {
    const o = await this.prisma.marketplaceOrder.findFirst({ where: { id: orderId, tenantId: user.tenantId } });
    if (!o) throw new NotFoundException('Заказ');
    return this.prisma.marketplaceOrder.update({
      where: { id: orderId },
      data: {
        tracking: body.tracking,
        pvz: body.pvz,
        status: body.status || (body.tracking ? 'delivering' : o.status),
      },
    });
  }

  async attachFile(user: Authed, body: { requestId?: string; clientId?: string; kind: string; name: string; base64: string }) {
    const dir = path.join(process.cwd(), '..', 'data', 'uploads', user.tenantId);
    fs.mkdirSync(dir, { recursive: true });
    const safe = Date.now() + '-' + body.name.replace(/[^\w.\-а-яА-Я]+/g, '_');
    const buf = Buffer.from(body.base64.replace(/^data:.*,/, ''), 'base64');
    const filePath = path.join(dir, safe);
    fs.writeFileSync(filePath, buf);
    return this.prisma.documentFile.create({
      data: {
        tenantId: user.tenantId,
        kind: body.kind,
        name: body.name,
        path: filePath,
        requestId: body.requestId,
        clientId: body.clientId,
      },
    });
  }

  async edoSend(user: Authed, invoiceId: string, provider: 'diadoc' | 'sbis') {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: user.tenantId },
      include: { client: true, legalEntity: true },
    });
    if (!inv) throw new NotFoundException('Счёт');
    const pdf = await pdfBuffer((doc) => {
      doc.fontSize(14).text('УПД / ЭДО ' + provider);
      doc.moveDown();
      doc.fontSize(10).text(inv.number + ' · ' + inv.client.name);
      doc.text('Сумма: ' + (inv.amountKop / 100).toFixed(2) + ' ' + inv.currency);
      doc.text('Юрлицо: ' + (inv.legalEntity?.name || ''));
      doc.moveDown();
      doc.text('Документ поставлен в очередь ' + provider + ' (официальный API). Без ключа — демо.');
    });
    const rec = await this.attachFile(user, {
      kind: 'edo-' + provider,
      name: `edo-${inv.number}.pdf`,
      base64: pdf.toString('base64'),
      clientId: inv.clientId,
    });
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'edo',
      title: 'ЭДО ' + provider,
      body: inv.number,
      clientId: inv.clientId,
    });
    return { queued: true, provider, fileId: rec.id, demo: true };
  }

  async waybillPdf(user: Authed, requestId: string) {
    const req = await this.prisma.request.findFirst({
      where: { id: requestId, tenantId: user.tenantId },
      include: { lines: true, client: true },
    });
    if (!req) throw new NotFoundException('Заявка');
    const buf = await pdfBuffer((doc) => {
      doc.fontSize(16).text('Товарная накладная ' + req.number);
      doc.fontSize(10).text('Клиент: ' + (req.client?.name || ''));
      doc.text('Дата: ' + new Date(req.createdAt).toLocaleDateString('ru'));
      doc.moveDown();
      req.lines.forEach((l, i) => doc.text(`${i + 1}. ${l.sku}  ${l.name}  ${l.factQty || l.plannedQty} шт`));
      doc.moveDown(2);
      doc.text('Сдал ________________     Принял ________________');
    });
    return { name: `tn-${req.number}.pdf`, mime: 'application/pdf', base64: buf.toString('base64') };
  }
}
