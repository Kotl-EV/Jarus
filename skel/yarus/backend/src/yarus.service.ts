import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { applyMove, availableGood, explodeBundle, runStockTx, STOCK } from './stock.engine';
import { notify } from './notify';
import { PROCESS_PRESETS, SERVICE_PRESET } from './process-presets';
import { decryptSecret, encryptSecret, hashToken } from './crypto-util';
import { defaultPermissions, isClient, requires2fa } from './permissions';
import { randomBytes } from 'crypto';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

const DATA = path.join(process.cwd(), '..', 'data');

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

@Injectable()
export class YarusService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(JwtService) private jwt: JwtService,
  ) {
    ensureDir(DATA);
    ensureDir(path.join(DATA, 'uploads'));
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      include: { tenant: true },
    });
    if (!user || !user.active) throw new BadRequestException('Неверный логин или пароль');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new BadRequestException('Неверный логин или пароль');
    if (user.tenant.blocked) throw new ForbiddenException('Организация заблокирована');
    const need2fa = requires2fa(user.role) && user.totpEnabled;
    const token = await this.jwt.signAsync(
      { sub: user.id, tfa: !need2fa },
      { expiresIn: '12h' },
    );
    return {
      token,
      require2fa: need2fa,
      totpSetup: requires2fa(user.role) && !user.totpEnabled,
      user: this.safeUser(user),
    };
  }

  async verifyTotp(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpSecret) throw new BadRequestException('2FA не настроена');
    if (!authenticator.check(code, user.totpSecret)) throw new BadRequestException('Неверный код');
    const token = await this.jwt.signAsync({ sub: user.id, tfa: true }, { expiresIn: '12h' });
    return { token };
  }

  async setupTotp(user: Authed) {
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } });
    const otpauth = authenticator.keyuri(user.email, 'Ярус', secret);
    return { secret, otpauth };
  }

  async confirmTotp(user: Authed, code: string) {
    const u = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!u?.totpSecret) throw new BadRequestException('Сначала получите секрет');
    if (!authenticator.check(code, u.totpSecret)) throw new BadRequestException('Неверный код');
    await this.prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
    const token = await this.jwt.signAsync({ sub: user.id, tfa: true }, { expiresIn: '12h' });
    return { token, ok: true };
  }

  safeUser(user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    clientId: string | null;
    tenantId: string;
    totpEnabled: boolean;
  }) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      clientId: user.clientId,
      tenantId: user.tenantId,
      totpEnabled: user.totpEnabled,
    };
  }

  async audit(user: Authed, action: string, entity: string, entityId?: string, after?: unknown, before?: unknown) {
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id.startsWith('api:') ? null : user.id,
        action,
        entity,
        entityId,
        after: after ? JSON.stringify(after) : null,
        before: before ? JSON.stringify(before) : null,
      },
    });
  }

  tenantWhere(user: Authed) {
    return { tenantId: user.tenantId };
  }

  async dashboard(user: Authed) {
    const t = user.tenantId;
    const clientFilter = isClient(user.role) && user.clientId ? { clientId: user.clientId } : {};
    const [products, requests, openTasks, fbs, invoices, moves, cis, clients] = await Promise.all([
      this.prisma.product.count({ where: { tenantId: t, archived: false, ...clientFilter } }),
      this.prisma.request.count({ where: { tenantId: t, status: { not: 'done' }, ...clientFilter } }),
      this.prisma.task.count({ where: { tenantId: t, status: 'open' } }),
      this.prisma.marketplaceOrder.count({ where: { tenantId: t, status: { notIn: ['delivered', 'cancelled'] } } }),
      this.prisma.invoice.aggregate({ where: { tenantId: t, status: { not: 'paid' }, ...clientFilter }, _sum: { amountKop: true } }),
      this.prisma.stockMove.count({ where: { tenantId: t } }),
      this.prisma.cisCode.count({ where: { tenantId: t, status: 'in_circulation' } }),
      this.prisma.client.count({ where: { tenantId: t } }),
    ]);
    const stock = await this.prisma.stockBalance.groupBy({
      by: ['stockType'],
      where: { tenantId: t, ...clientFilter },
      _sum: { qty: true },
    });
    const recent = await this.prisma.stockMove.findMany({
      where: { tenantId: t },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
    const overdue = await this.prisma.task.findMany({
      where: { tenantId: t, status: 'open', dueAt: { lt: new Date() } },
      take: 8,
    });
    return {
      kpis: {
        products,
        requests,
        openTasks,
        fbs,
        debtKop: invoices._sum.amountKop || 0,
        moves,
        cis,
        clients,
      },
      stock,
      recent,
      overdue,
    };
  }

  async bootstrapTenant(data: {
    orgName: string;
    slug?: string;
    mode: string;
    currency: string;
    country: string;
    legalName: string;
    inn?: string;
    warehouseName: string;
    ownerEmail: string;
    ownerName: string;
    password: string;
  }) {
    const slug = await this.uniqueSlug(data.slug || data.orgName);
    if (!data.ownerEmail || !data.password || !data.orgName) {
      throw new BadRequestException('Укажите название склада, почту и пароль');
    }
    const tenant = await this.prisma.tenant.create({
      data: {
        slug,
        name: data.orgName,
        mode: data.mode,
        currency: data.currency,
        featureFlags: JSON.stringify({
          constructor: true,
          cis: true,
          white_label: false,
          gis_mt: false,
        }),
      },
    });
    const le = await this.prisma.legalEntity.create({
      data: {
        tenantId: tenant.id,
        name: data.legalName,
        inn: data.inn,
        country: data.country,
        isPrimary: true,
        currency: data.currency,
      },
    });
    const wh = await this.prisma.warehouse.create({
      data: {
        tenantId: tenant.id,
        legalEntityId: le.id,
        name: data.warehouseName,
        code: 'WH1',
      },
    });
    await this.ensureSpecialCells(tenant.id, wh.id);
    await this.generateGrid(tenant.id, wh.id, { aisles: 2, racks: 2, shelves: 2, cells: 4 });
    for (const [code, def] of Object.entries(PROCESS_PRESETS)) {
      await this.prisma.requestType.create({
        data: {
          tenantId: tenant.id,
          code,
          name: def.name,
          builtIn: true,
          stagesJson: JSON.stringify(def.stages),
        },
      });
    }
    for (const s of SERVICE_PRESET) {
      await this.prisma.service.create({ data: { tenantId: tenant.id, ...s } });
    }
    const hash = await bcrypt.hash(data.password, 10);
    const owner = await this.prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: data.ownerEmail.toLowerCase(),
        passwordHash: hash,
        fullName: data.ownerName,
        role: 'Owner',
      },
    });
    return { tenant, warehouse: wh, ownerId: owner.id };
  }

  private async uniqueSlug(raw: string) {
    const map: Record<string, string> = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
      к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
      х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    };
    let s = (raw || '')
      .toLowerCase()
      .split('')
      .map((ch) => map[ch] ?? ch)
      .join('')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!s) s = 'sklad';
    let slug = s;
    let n = 2;
    while (await this.prisma.tenant.findUnique({ where: { slug } })) {
      slug = `${s}-${n++}`;
    }
    return slug;
  }

  async ensureSpecialCells(tenantId: string, warehouseId: string) {
    const special = [
      ['RCV', 'receiving', 'Приёмка'],
      ['SHP', 'shipping', 'Отгрузка'],
      ['DEF', 'defect', 'Брак'],
      ['QRN', 'quarantine', 'Карантин'],
      ['BUF', 'buffer', 'Буфер'],
      ['TRN', 'transit', 'Транзит'],
      ['NOM', 'virtual', 'Номинал'],
    ];
    for (const [code, type] of special) {
      const exists = await this.prisma.cell.findFirst({ where: { tenantId, warehouseId, code } });
      if (!exists) {
        await this.prisma.cell.create({
          data: { tenantId, warehouseId, code, type, volumeCm3: 0, mixClients: true, mixLots: true },
        });
      }
    }
  }

  async generateGrid(
    tenantId: string,
    warehouseId: string,
    g: { aisles: number; racks: number; shelves: number; cells: number; zone?: string },
  ) {
    const zone = await this.prisma.zone.create({
      data: {
        tenantId,
        warehouseId,
        name: g.zone || 'Хранение',
        code: 'A',
        type: 'storage',
      },
    });
    let n = 0;
    for (let a = 1; a <= g.aisles; a++) {
      for (let r = 1; r <= g.racks; r++) {
        for (let s = 1; s <= g.shelves; s++) {
          for (let c = 1; c <= g.cells; c++) {
            const code = `A-${pad(a)}-${pad(r)}-${pad(s)}-${pad(c)}`;
            await this.prisma.cell.create({
              data: {
                tenantId,
                warehouseId,
                zoneId: zone.id,
                code,
                aisle: String(a),
                rack: String(r),
                shelf: String(s),
                type: 'storage',
                volumeCm3: 800000,
                maxWeightG: 25000,
              },
            });
            n++;
          }
        }
      }
    }
    return { created: n, zoneId: zone.id };
  }

  async specialCell(tenantId: string, warehouseId: string, type: string) {
    const map: Record<string, string> = {
      receiving: 'RCV',
      shipping: 'SHP',
      defect: 'DEF',
      quarantine: 'QRN',
      buffer: 'BUF',
      transit: 'TRN',
      virtual: 'NOM',
      nominal: 'NOM',
    };
    const code = map[type] || type;
    const cell = await this.prisma.cell.findFirst({ where: { tenantId, warehouseId, code } });
    if (!cell) throw new NotFoundException('Служебная ячейка ' + code);
    return cell;
  }

  async createClient(user: Authed, body: Record<string, unknown>) {
    const c = await this.prisma.client.create({
      data: {
        tenantId: user.tenantId,
        name: String(body.name),
        inn: body.inn ? String(body.inn) : undefined,
        legalEntityId: body.legalEntityId ? String(body.legalEntityId) : undefined,
        email: body.email ? String(body.email) : undefined,
        telegramChatId: body.telegramChatId ? String(body.telegramChatId) : undefined,
        freeStorageDays: Number(body.freeStorageDays || 0),
        storageRateKop: Number(body.storageRateKop || 150),
        seeCells: body.seeCells !== false,
        canCreateBundles: body.canCreateBundles !== false,
        canEditRequests: body.canEditRequests !== false,
      },
    });
    if (body.email && body.password) {
      await this.prisma.user.create({
        data: {
          tenantId: user.tenantId,
          email: String(body.email).toLowerCase(),
          passwordHash: await bcrypt.hash(String(body.password), 10),
          fullName: String(body.contactName || body.name),
          role: 'ClientAdmin',
          clientId: c.id,
        },
      });
    }
    await this.audit(user, 'create', 'Client', c.id, c);
    return c;
  }

  async createProduct(user: Authed, body: Record<string, unknown>) {
    const clientId = isClient(user.role) ? user.clientId! : String(body.clientId);
    const volume =
      Number(body.volumeCm3 || 0) ||
      Math.round((Number(body.widthMm || 0) * Number(body.heightMm || 0) * Number(body.lengthMm || 0)) / 1000);
    const p = await this.prisma.product.create({
      data: {
        tenantId: user.tenantId,
        clientId,
        name: String(body.name),
        sku: String(body.sku),
        articleMp: body.articleMp ? String(body.articleMp) : undefined,
        photoUrl: body.photoUrl ? String(body.photoUrl) : undefined,
        widthMm: Number(body.widthMm || 0),
        heightMm: Number(body.heightMm || 0),
        lengthMm: Number(body.lengthMm || 0),
        weightG: Number(body.weightG || 0),
        volumeCm3: volume,
        requiresCis: !!body.requiresCis,
        packingReq: body.packingReq ? String(body.packingReq) : undefined,
        reorderPoint: Number(body.reorderPoint || 0),
        tags: String(body.tags || ''),
      },
    });
    if (body.barcode) {
      await this.addBarcode(user, p.id, String(body.barcode), 'ean13');
    }
    return this.prisma.product.findUnique({ where: { id: p.id }, include: { barcodes: true, bundleItems: true } });
  }

  async addBarcode(user: Authed, productId: string, code: string, kind = 'ean13') {
    try {
      return await this.prisma.barcode.create({
        data: { tenantId: user.tenantId, productId, code: code.trim(), kind },
      });
    } catch {
      throw new ConflictException('Штрихкод уже занят');
    }
  }

  generateBarcode(): string {
    const n = Date.now().toString().slice(-11);
    return '2' + n;
  }

  async findByBarcode(tenantId: string, code: string) {
    const bc = await this.prisma.barcode.findUnique({ where: { tenantId_code: { tenantId, code } } });
    if (bc) return this.prisma.product.findUnique({ where: { id: bc.productId }, include: { barcodes: true } });
    return this.prisma.product.findFirst({ where: { tenantId, sku: code } });
  }

  async requestWarnings(user: Authed, typeCode: string, lines: { productId: string; qty: number }[], warehouseId?: string) {
    const warnings: { code: string; message: string }[] = [];
    for (const line of lines) {
      const p = await this.prisma.product.findFirst({ where: { id: line.productId, tenantId: user.tenantId } });
      if (!p) {
        warnings.push({ code: 'no_product', message: 'Товар не найден' });
        continue;
      }
      if (!p.volumeCm3) warnings.push({ code: 'no_dims', message: `${p.sku}: нет габаритов` });
      const avail = await availableGood(this.prisma, {
        tenantId: user.tenantId,
        warehouseId,
        productId: p.id,
        clientId: p.clientId,
      });
      if (['fbs', 'fbo', 'pickup'].includes(typeCode) && avail < line.qty) {
        warnings.push({ code: 'no_stock', message: `${p.sku}: нужно ${line.qty}, доступно ${avail}` });
      }
      if (p.requiresCis) {
        const cis = await this.prisma.cisCode.count({
          where: { tenantId: user.tenantId, productId: p.id, status: { in: ['uploaded', 'printed', 'labeled', 'in_circulation'] } },
        });
        if (cis < line.qty) warnings.push({ code: 'no_cis', message: `${p.sku}: КИЗ ${cis} из ${line.qty}` });
      }
    }
    return warnings;
  }

  async createRequest(user: Authed, body: Record<string, unknown>) {
    const type = await this.prisma.requestType.findFirst({
      where: { tenantId: user.tenantId, code: String(body.typeCode || body.typeId), version: Number(body.version || 1) },
    }) || await this.prisma.requestType.findFirst({
      where: { tenantId: user.tenantId, id: String(body.typeId || '') },
    });
    if (!type) throw new NotFoundException('Тип заявки не найден');
    const stages = JSON.parse(type.stagesJson) as { key: string; title: string; slaMinutes?: number }[];
    const lines = (body.lines as { productId: string; qty: number; name?: string; sku?: string }[]) || [];
    const warnings = await this.requestWarnings(user, type.code, lines.map((l) => ({ productId: l.productId, qty: l.qty })), body.warehouseId as string);
    const count = await this.prisma.request.count({ where: { tenantId: user.tenantId } });
    const number = `Z-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
    const clientId = isClient(user.role) ? user.clientId : (body.clientId as string);
    const req = await this.prisma.request.create({
      data: {
        tenantId: user.tenantId,
        number,
        typeId: type.id,
        clientId,
        warehouseId: (body.warehouseId as string) || undefined,
        status: isClient(user.role) ? 'pending' : 'draft',
        currentStageKey: isClient(user.role) ? 'wait_wh' : stages[0]?.key,
        locked: isClient(user.role),
        source: isClient(user.role) ? 'lk' : String(body.source || 'staff'),
        warningJson: JSON.stringify(warnings),
        payloadJson: JSON.stringify(body.payload || {}),
        gtd: body.gtd ? String(body.gtd) : undefined,
        marketplace: body.marketplace ? String(body.marketplace) : undefined,
        createdById: user.id,
        slaDueAt: stages[0]?.slaMinutes ? new Date(Date.now() + stages[0].slaMinutes * 60000) : undefined,
        lines: {
          create: await Promise.all(
            lines.map(async (l) => {
              const p = await this.prisma.product.findFirst({ where: { id: l.productId, tenantId: user.tenantId } });
              return {
                tenantId: user.tenantId,
                productId: l.productId,
                sku: p?.sku || l.sku || '',
                name: p?.name || l.name || '',
                plannedQty: l.qty,
              };
            }),
          ),
        },
        stages: {
          create: stages.map((s, i) => ({
            tenantId: user.tenantId,
            key: s.key,
            title: s.title,
            status: isClient(user.role) ? 'pending' : i === 0 ? 'current' : 'pending',
            slaMinutes: s.slaMinutes || 0,
          })),
        },
      },
      include: { lines: true, stages: true, type: true },
    });
    await this.prisma.task.create({
      data: {
        tenantId: user.tenantId,
        requestId: req.id,
        title: `${type.name} ${number}`,
        dueAt: req.slaDueAt,
        warehouseId: req.warehouseId,
        kind: 'request',
      },
    });
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: isClient(user.role) ? 'request.pending' : 'request.created',
      title: isClient(user.role) ? `Продавец прислал заявку ${number}` : `Заявка ${number}`,
      body: isClient(user.role) ? 'Нужно принять товар на склад или отклонить.' : `${type.name} создана`,
      clientId: clientId || undefined,
    });
    return { ...req, warnings };
  }

  async decideRequest(user: Authed, id: string, ok: boolean, reason?: string) {
    if (isClient(user.role)) throw new ForbiddenException('Решает склад, не продавец');
    const req = await this.getRequest(user, id);
    if (req.status !== 'pending') throw new BadRequestException('Эта заявка уже рассмотрена');
    if (!ok) {
      const payload = JSON.parse(req.payloadJson || '{}');
      payload.rejectReason = reason || 'Склад отклонил';
      const updated = await this.prisma.request.update({
        where: { id },
        data: { status: 'rejected', currentStageKey: 'rejected', payloadJson: JSON.stringify(payload) },
        include: { lines: true, stages: true, type: true, client: true },
      });
      await notify(this.prisma, {
        tenantId: user.tenantId,
        event: 'request.rejected',
        title: `Склад отклонил ${req.number}`,
        body: payload.rejectReason,
        clientId: req.clientId || undefined,
      });
      return updated;
    }
    const stages = JSON.parse(req.type.stagesJson) as { key: string }[];
    const first = stages[0]?.key || 'receive';
    await this.prisma.requestStage.updateMany({
      where: { requestId: id, key: first },
      data: { status: 'current', startedAt: new Date() },
    });
    const updated = await this.prisma.request.update({
      where: { id },
      data: { status: 'in_progress', locked: true, currentStageKey: first },
      include: { lines: true, stages: true, type: true, client: true },
    });
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'request.approved',
      title: `Склад принял ${req.number}`,
      body: 'Товар можно везти. Склад оформит приёмку.',
      clientId: req.clientId || undefined,
    });
    await this.audit(user, 'approve', 'Request', id);
    return updated;
  }

  async startRequest(user: Authed, id: string) {
    const req = await this.getRequest(user, id);
    if (req.locked) throw new BadRequestException('Заявка уже запущена');
    const updated = await this.prisma.request.update({
      where: { id },
      data: { locked: true, status: 'in_progress' },
      include: { lines: true, stages: true, type: true },
    });
    await this.runAutoActions(user, updated);
    await this.audit(user, 'start', 'Request', id);
    return updated;
  }

  async advanceRequest(user: Authed, id: string, photo?: string) {
    const req = await this.getRequest(user, id);
    if (isClient(user.role) && req.locked && !user.permissions.clientEditRequests) {
      throw new ForbiddenException('После старта клиент не может двигать заявку');
    }
    const stages = [...req.stages].sort((a, b) => a.title.localeCompare(b.title));
    const ordered = JSON.parse(req.type.stagesJson) as { key: string }[];
    const idx = ordered.findIndex((s) => s.key === req.currentStageKey);
    await this.prisma.requestStage.updateMany({
      where: { requestId: id, key: req.currentStageKey || '' },
      data: { status: 'done', closedAt: new Date(), closedById: user.id },
    });
    const next = ordered[idx + 1];
    if (!next) {
      await this.prisma.request.update({ where: { id }, data: { status: 'done', currentStageKey: 'done' } });
      await this.prisma.task.updateMany({ where: { requestId: id }, data: { status: 'done' } });
      await notify(this.prisma, {
        tenantId: user.tenantId,
        event: 'request.done',
        title: `Заявка ${req.number} закрыта`,
        body: 'Все этапы выполнены',
        clientId: req.clientId || undefined,
      });
      return this.getRequest(user, id);
    }
    await this.prisma.requestStage.updateMany({
      where: { requestId: id, key: next.key },
      data: { status: 'current', startedAt: new Date() },
    });
    const payload = JSON.parse(req.payloadJson || '{}');
    if (photo) payload.photos = [...(payload.photos || []), photo];
    await this.prisma.request.update({
      where: { id },
      data: { currentStageKey: next.key, payloadJson: JSON.stringify(payload), status: 'in_progress' },
    });
    const fresh = await this.getRequest(user, id);
    await this.runAutoActions(user, fresh);
    return fresh;
  }

  async runAutoActions(user: Authed, req: Awaited<ReturnType<YarusService['getRequest']>>) {
    const defs = JSON.parse(req.type.stagesJson) as {
      key: string;
      autoActions?: { type: string }[];
    }[];
    const def = defs.find((d) => d.key === req.currentStageKey);
    for (const a of def?.autoActions || []) {
      if (a.type === 'telegram') {
        await notify(this.prisma, {
          tenantId: user.tenantId,
          event: 'stage',
          title: req.number,
          body: `Этап ${req.currentStageKey}`,
          clientId: req.clientId || undefined,
        });
      }
      if (a.type === 'reserve' && req.warehouseId) {
        for (const line of req.lines) {
          const p = await this.prisma.product.findFirst({ where: { id: line.productId } });
          if (!p) continue;
          const from = await this.prisma.stockBalance.findFirst({
            where: { tenantId: user.tenantId, productId: p.id, stockType: STOCK.GOOD, qty: { gte: line.plannedQty } },
          });
          if (!from) continue;
          const ship = await this.specialCell(user.tenantId, req.warehouseId, 'shipping');
          await runStockTx(this.prisma, (tx) =>
            applyMove(tx, {
              tenantId: user.tenantId,
              type: 'reserve',
              productId: p.id,
              clientId: p.clientId,
              qty: line.plannedQty,
              warehouseId: req.warehouseId!,
              from: { cellId: from.cellId, stockType: STOCK.GOOD, lotId: from.lotId, containerId: from.containerId },
              to: { cellId: ship.id, stockType: STOCK.RESERVE_REQUEST },
              requestId: req.id,
              userId: user.id,
            }),
          );
        }
      }
      if (a.type === 'nominal' && req.warehouseId) {
        const nom = await this.specialCell(user.tenantId, req.warehouseId, 'nominal');
        for (const line of req.lines) {
          const p = await this.prisma.product.findFirst({ where: { id: line.productId } });
          if (!p) continue;
          await runStockTx(this.prisma, (tx) =>
            applyMove(tx, {
              tenantId: user.tenantId,
              type: 'nominal_receipt',
              productId: p.id,
              clientId: p.clientId,
              qty: line.plannedQty,
              warehouseId: req.warehouseId!,
              to: { cellId: nom.id, stockType: STOCK.NOMINAL },
              requestId: req.id,
              userId: user.id,
            }),
          );
        }
      }
      if (a.type === 'calendar_task') {
        await this.prisma.task.create({
          data: {
            tenantId: user.tenantId,
            requestId: req.id,
            title: `Этап ${req.currentStageKey} / ${req.number}`,
            warehouseId: req.warehouseId,
          },
        });
      }
    }
  }

  async getRequest(user: Authed, id: string) {
    const req = await this.prisma.request.findFirst({
      where: { id, tenantId: user.tenantId, ...(isClient(user.role) && user.clientId ? { clientId: user.clientId } : {}) },
      include: { lines: true, stages: true, type: true, expenses: true, facts: true },
    });
    if (!req) throw new NotFoundException('Заявка не найдена');
    return req;
  }

  async acceptScan(user: Authed, body: {
    requestId?: string;
    warehouseId: string;
    cellCode?: string;
    barcode: string;
    qty?: number;
    defect?: boolean;
    photo?: string;
    cis?: string;
    containerBarcode?: string;
    allowNegative?: boolean;
  }) {
    const product = await this.findByBarcode(user.tenantId, body.barcode);
    if (!product) throw new NotFoundException('Штрихкод не найден');
    const rcv = await this.specialCell(user.tenantId, body.warehouseId, 'receiving');
    let cellId = rcv.id;
    if (body.cellCode) {
      const cell = await this.prisma.cell.findFirst({
        where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: body.cellCode },
      });
      if (!cell) throw new NotFoundException('Ячейка не найдена');
      if (cell.blocked) throw new ForbiddenException('Ячейка заблокирована');
      cellId = cell.id;
    }
    const stockType = body.defect ? STOCK.DEFECT : STOCK.GOOD;
    const dest = body.defect ? (await this.specialCell(user.tenantId, body.warehouseId, 'defect')).id : cellId;
    const qty = body.qty || 1;
    let containerId = '';
    if (body.containerBarcode) {
      const existing = await this.prisma.container.findUnique({
        where: { tenantId_barcode: { tenantId: user.tenantId, barcode: body.containerBarcode } },
      });
      const box =
        existing ||
        (await this.prisma.container.create({
          data: {
            tenantId: user.tenantId,
            kind: 'box',
            barcode: body.containerBarcode,
            cellId: dest,
            clientId: product.clientId,
          },
        }));
      containerId = box.id;
    }
    if (body.cis) await this.attachCis(user, product.id, body.cis, 'labeled');
    await runStockTx(this.prisma, async (tx) => {
      await applyMove(tx, {
        tenantId: user.tenantId,
        type: body.defect ? 'defect' : 'receipt',
        productId: product.id,
        clientId: product.clientId,
        qty,
        warehouseId: body.warehouseId,
        to: { cellId: dest, stockType, containerId: containerId || undefined },
        requestId: body.requestId,
        userId: user.id,
        device: 'tsd',
        barcode: body.barcode,
        cis: body.cis,
        allowNegative: false,
      });
      const nom = await tx.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: 'NOM' } });
      if (nom) {
        await applyMove(tx, {
          tenantId: user.tenantId,
          type: 'nominal_receipt',
          productId: product.id,
          clientId: product.clientId,
          qty,
          warehouseId: body.warehouseId,
          to: { cellId: nom.id, stockType: STOCK.NOMINAL },
          requestId: body.requestId,
          userId: user.id,
        });
      }
      if (body.requestId) {
        await tx.requestLine.updateMany({
          where: { requestId: body.requestId, productId: product.id },
          data: body.defect ? { defectQty: { increment: qty } } : { factQty: { increment: qty } },
        });
      }
    });
    if (user.permissions.stock && qty) {
      await this.prisma.piecework.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          kind: 'acceptance',
          qty,
          rateKop: 80,
          amountKop: 80 * qty,
          requestId: body.requestId,
        },
      });
    }
    return { product, qty, defect: !!body.defect };
  }

  async pickScan(user: Authed, body: { warehouseId: string; barcode: string; requestId?: string; orderId?: string; qty?: number }) {
    const product = await this.findByBarcode(user.tenantId, body.barcode);
    if (!product) throw new NotFoundException('Штрихкод не найден');
    const qty = body.qty || 1;
    const components = await explodeBundle(this.prisma, user.tenantId, product.id);
    const ship = await this.specialCell(user.tenantId, body.warehouseId, 'shipping');
    await runStockTx(this.prisma, async (tx) => {
      for (const c of components) {
        const from = await tx.stockBalance.findFirst({
          where: { tenantId: user.tenantId, productId: c.productId, stockType: STOCK.GOOD, qty: { gte: c.qty * qty } },
        });
        if (!from) throw new ForbiddenException('Нет остатка для сборки');
        await applyMove(tx, {
          tenantId: user.tenantId,
          type: 'pick',
          productId: c.productId,
          clientId: product.clientId,
          qty: c.qty * qty,
          warehouseId: body.warehouseId,
          from: { cellId: from.cellId, stockType: STOCK.GOOD, lotId: from.lotId, containerId: from.containerId },
          to: { cellId: ship.id, stockType: STOCK.RESERVE_FBS },
          requestId: body.requestId,
          userId: user.id,
          barcode: body.barcode,
          allowNegative: user.permissions.stockNegative,
        });
      }
    });
    await this.prisma.piecework.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        kind: 'pick',
        qty,
        rateKop: 120,
        amountKop: 120 * qty,
        requestId: body.requestId,
      },
    });
    return { product, qty, components };
  }

  async ship(user: Authed, body: { warehouseId: string; requestId?: string; orderId?: string; lines?: { productId: string; qty: number }[] }) {
    const ship = await this.specialCell(user.tenantId, body.warehouseId, 'shipping');
    const lines = body.lines || [];
    await runStockTx(this.prisma, async (tx) => {
      for (const line of lines) {
        const p = await tx.product.findFirst({ where: { id: line.productId, tenantId: user.tenantId } });
        if (!p) continue;
        if (p.requiresCis) {
          const ready = await tx.cisCode.count({
            where: { tenantId: user.tenantId, productId: p.id, status: { in: ['labeled', 'in_circulation'] } },
          });
          if (ready < line.qty) throw new ForbiddenException(`Отгрузка ${p.sku} без КИЗ запрещена`);
        }
        await applyMove(tx, {
          tenantId: user.tenantId,
          type: 'shipment',
          productId: p.id,
          clientId: p.clientId,
          qty: line.qty,
          warehouseId: body.warehouseId,
          from: { cellId: ship.id, stockType: STOCK.RESERVE_FBS },
          requestId: body.requestId,
          userId: user.id,
        });
        const nom = await tx.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId: body.warehouseId, code: 'NOM' } });
        if (nom) {
          await applyMove(tx, {
            tenantId: user.tenantId,
            type: 'nominal_writeoff',
            productId: p.id,
            clientId: p.clientId,
            qty: line.qty,
            warehouseId: body.warehouseId,
            from: { cellId: nom.id, stockType: STOCK.NOMINAL },
            requestId: body.requestId,
            userId: user.id,
            allowNegative: user.permissions.stockNegative,
          });
        }
      }
    });
    if (body.orderId) {
      await this.prisma.marketplaceOrder.update({
        where: { id: body.orderId },
        data: { status: 'delivering' },
      });
    }
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'fbs.shipped',
      title: 'Отгрузка FBS',
      body: 'Заказ отгружен на ПВЗ',
      userId: user.id,
    });
    return { ok: true };
  }

  async transferNominal(user: Authed, body: { productId: string; qty: number; fromClientId: string; toClientId: string; warehouseId: string }) {
    const nom = await this.specialCell(user.tenantId, body.warehouseId, 'nominal');
    await runStockTx(this.prisma, async (tx) => {
      await applyMove(tx, {
        tenantId: user.tenantId,
        type: 'nominal_transfer',
        productId: body.productId,
        clientId: body.fromClientId,
        qty: body.qty,
        warehouseId: body.warehouseId,
        from: { cellId: nom.id, stockType: STOCK.NOMINAL },
        userId: user.id,
        document: `to:${body.toClientId}`,
      });
      await applyMove(tx, {
        tenantId: user.tenantId,
        type: 'nominal_transfer',
        productId: body.productId,
        clientId: body.toClientId,
        qty: body.qty,
        warehouseId: body.warehouseId,
        to: { cellId: nom.id, stockType: STOCK.NOMINAL },
        userId: user.id,
        document: `from:${body.fromClientId}`,
      });
    });
    await this.audit(user, 'nominal_transfer', 'Stock', body.productId, body);
    return { ok: true };
  }

  async attachCis(user: Authed, productId: string, code: string, status: string) {
    const existing = await this.prisma.cisCode.findUnique({
      where: { tenantId_code: { tenantId: user.tenantId, code } },
    });
    if (existing && existing.productId && existing.productId !== productId) {
      throw new ConflictException('КИЗ уже привязан к другому товару');
    }
    if (existing) {
      return this.prisma.cisCode.update({ where: { id: existing.id }, data: { productId, status } });
    }
    const p = await this.prisma.product.findFirst({ where: { id: productId, tenantId: user.tenantId } });
    return this.prisma.cisCode.create({
      data: { tenantId: user.tenantId, productId, clientId: p?.clientId, code, status },
    });
  }

  async importCis(user: Authed, codes: string[], productId?: string) {
    const result = { created: 0, duplicates: 0 };
    for (const raw of codes) {
      const code = raw.trim();
      if (!code) continue;
      try {
        await this.prisma.cisCode.create({
          data: {
            tenantId: user.tenantId,
            code,
            productId,
            clientId: isClient(user.role) ? user.clientId : undefined,
          },
        });
        result.created++;
      } catch {
        result.duplicates++;
      }
    }
    return result;
  }

  async printCis(user: Authed, ids: string[], reprint = false) {
    if (reprint && !user.permissions.cisReprint) throw new ForbiddenException('Повторная печать КИЗ запрещена');
    if (!user.permissions.cisPrint) throw new ForbiddenException('Нет права печати КИЗ');
    const codes = await this.prisma.cisCode.findMany({ where: { tenantId: user.tenantId, id: { in: ids } } });
    for (const c of codes) {
      if (c.printCopies > 0 && !reprint) throw new ForbiddenException(`КИЗ уже печатался: ${c.code.slice(0, 12)}…`);
      await this.prisma.cisCode.update({
        where: { id: c.id },
        data: { printCopies: { increment: 1 }, printedAt: new Date(), status: c.status === 'uploaded' ? 'printed' : c.status },
      });
    }
    await this.prisma.printJob.create({
      data: { tenantId: user.tenantId, status: 'queued', copies: ids.length },
    });
    return { printed: codes.length };
  }

  async snapshotStorage(tenantId: string, date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    const clients = await this.prisma.client.findMany({ where: { tenantId } });
    const out = [];
    for (const c of clients) {
      const bals = await this.prisma.stockBalance.findMany({
        where: { tenantId, clientId: c.id, stockType: { in: [STOCK.GOOD, STOCK.NOMINAL, STOCK.DEFECT] } },
        include: { product: true },
      });
      let volume = 0;
      for (const b of bals) {
        if (c.storageUnit === 'volume_day') volume += (b.product.volumeCm3 || 0) * b.qty;
      }
      const free = c.freeStorageDays > 0 ? c.freeStorageDays : 0;
      const daysCharged = 1;
      const amount = Math.round((volume / 1_000_000) * c.storageRateKop * daysCharged);
      const rec = await this.prisma.storageDaily.upsert({
        where: { tenantId_clientId_date: { tenantId, clientId: c.id, date: day } },
        create: { tenantId, clientId: c.id, date: day, volumeCm3: volume, amountKop: amount },
        update: { volumeCm3: volume, amountKop: amount },
      });
      out.push({ clientId: c.id, volume, amount, free, rec });
    }
    return out;
  }

  async buildInvoice(user: Authed, body: { clientId: string; kind: string; periodFrom?: string; periodTo?: string; requestId?: string }) {
    const client = await this.prisma.client.findFirst({ where: { id: body.clientId, tenantId: user.tenantId } });
    if (!client) throw new NotFoundException('Клиент');
    const lines: { title: string; amountKop: number }[] = [];
    if (body.kind === 'storage' && body.periodFrom && body.periodTo) {
      const days = await this.prisma.storageDaily.findMany({
        where: { tenantId: user.tenantId, clientId: client.id, date: { gte: body.periodFrom, lte: body.periodTo } },
      });
      const sum = days.reduce((s, d) => s + d.amountKop, 0);
      lines.push({ title: `Хранение ${body.periodFrom}–${body.periodTo}`, amountKop: sum });
    }
    const facts = await this.prisma.serviceFact.findMany({
      where: {
        tenantId: user.tenantId,
        clientId: client.id,
        ...(body.requestId ? { requestId: body.requestId } : {}),
        createdAt: body.periodFrom && body.periodTo
          ? { gte: new Date(body.periodFrom), lte: new Date(body.periodTo + 'T23:59:59') }
          : undefined,
      },
    });
    for (const f of facts) lines.push({ title: f.serviceCode, amountKop: f.amountKop });
    const amountKop = lines.reduce((s, l) => s + l.amountKop, 0);
    const count = await this.prisma.invoice.count({ where: { tenantId: user.tenantId } });
    const number = `СЧ-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    const inv = await this.prisma.invoice.create({
      data: {
        tenantId: user.tenantId,
        clientId: client.id,
        legalEntityId: client.legalEntityId,
        number,
        kind: body.kind,
        status: 'issued',
        periodFrom: body.periodFrom,
        periodTo: body.periodTo,
        requestId: body.requestId,
        amountKop,
        currency: user.currency,
        linesJson: JSON.stringify(lines),
      },
    });
    await notify(this.prisma, {
      tenantId: user.tenantId,
      event: 'invoice',
      title: `Счёт ${number}`,
      body: `На сумму ${(amountKop / 100).toFixed(2)} ${user.currency}`,
      clientId: client.id,
    });
    return inv;
  }

  async fbsWebhook(tenantId: string, idempotency: string, payload: Record<string, unknown>, source = 'ozon') {
    const existing = await this.prisma.webhook.findUnique({
      where: { tenantId_idempotency: { tenantId, idempotency } },
    });
    if (existing) return { duplicate: true, id: existing.id };
    const account = await this.prisma.marketplaceAccount.findFirst({
      where: { tenantId, marketplace: source, active: true },
    });
    if (!account) throw new NotFoundException('Нет активного кабинета МП');
    const externalId = String(payload.posting_number || payload.order_id || payload.externalId || idempotency);
    const wh = await this.prisma.warehouse.findFirst({ where: { tenantId } });
    const items = (payload.products as { offer_id?: string; sku?: string; quantity?: number }[]) || [];
    const type = await this.prisma.requestType.findFirst({ where: { tenantId, code: 'fbs' } });
    const count = await this.prisma.request.count({ where: { tenantId } });
    const number = `FBS-${String(count + 1).padStart(6, '0')}`;
    const request = type
      ? await this.prisma.request.create({
          data: {
            tenantId,
            number,
            typeId: type.id,
            clientId: account.clientId,
            warehouseId: wh?.id,
            status: 'in_progress',
            locked: true,
            source: 'mp',
            marketplace: source,
            currentStageKey: 'reserve',
          },
        })
      : null;
    const order = await this.prisma.marketplaceOrder.create({
      data: {
        tenantId,
        accountId: account.id,
        externalId,
        postingNumber: externalId,
        status: 'awaiting_packaging',
        payloadJson: JSON.stringify(payload),
        reserved: true,
        requestId: request?.id,
        warehouseId: wh?.id,
      },
    });
    if (wh) {
      const ship = await this.specialCell(tenantId, wh.id, 'shipping');
      for (const it of items) {
        const sku = String(it.offer_id || it.sku || '');
        const product = await this.prisma.product.findFirst({ where: { tenantId, clientId: account.clientId, sku } });
        if (!product) continue;
        const from = await this.prisma.stockBalance.findFirst({
          where: { tenantId, productId: product.id, stockType: STOCK.GOOD, qty: { gte: it.quantity || 1 } },
        });
        if (!from) continue;
        await runStockTx(this.prisma, (tx) =>
          applyMove(tx, {
            tenantId,
            type: 'reserve',
            productId: product.id,
            clientId: product.clientId,
            qty: it.quantity || 1,
            warehouseId: wh.id,
            from: { cellId: from.cellId, stockType: STOCK.GOOD, lotId: from.lotId },
            to: { cellId: ship.id, stockType: STOCK.RESERVE_FBS },
            requestId: request?.id,
            document: externalId,
          }),
        );
        if (request) {
          await this.prisma.requestLine.create({
            data: {
              tenantId,
              requestId: request.id,
              productId: product.id,
              sku: product.sku,
              name: product.name,
              plannedQty: it.quantity || 1,
            },
          });
        }
      }
    }
    await this.prisma.webhook.create({
      data: {
        tenantId,
        idempotency,
        source,
        path: '/api/webhooks/fbs',
        payload: JSON.stringify(payload),
      },
    });
    await notify(this.prisma, {
      tenantId,
      event: 'fbs.new',
      title: `FBS ${externalId}`,
      body: 'Новый заказ, резерв создан',
      clientId: account.clientId,
    });
    return { duplicate: false, orderId: order.id, requestId: request?.id };
  }

  async cancelFbs(user: Authed, orderId: string) {
    const order = await this.prisma.marketplaceOrder.findFirst({ where: { id: orderId, tenantId: user.tenantId } });
    if (!order) throw new NotFoundException('Заказ');
    const moves = await this.prisma.stockMove.findMany({
      where: { tenantId: user.tenantId, document: order.externalId, type: 'reserve' },
    });
    if (order.warehouseId) {
      const ship = await this.specialCell(user.tenantId, order.warehouseId, 'shipping');
      for (const m of moves) {
        await runStockTx(this.prisma, (tx) =>
          applyMove(tx, {
            tenantId: user.tenantId,
            type: 'unreserve',
            productId: m.productId,
            clientId: m.clientId,
            qty: m.qty,
            warehouseId: order.warehouseId!,
            from: { cellId: ship.id, stockType: STOCK.RESERVE_FBS },
            to: { cellId: m.fromCellId || ship.id, stockType: STOCK.GOOD },
            userId: user.id,
            document: order.externalId,
          }),
        );
      }
    }
    await this.prisma.marketplaceOrder.update({ where: { id: orderId }, data: { status: 'cancelled', reserved: false } });
    return { ok: true };
  }

  async testMpAccount(user: Authed, accountId: string) {
    const acc = await this.prisma.marketplaceAccount.findFirst({
      where: { id: accountId, tenantId: user.tenantId, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
    });
    if (!acc) throw new NotFoundException('Магазин не найден');
    const key = decryptSecret(acc.apiKeyEnc);
    if (!key || !acc.clientIdExt) {
      return {
        ok: false,
        demo: true,
        message: 'Ключи ещё не введены. Заказы можно пробовать кнопкой «учебный заказ», живой Ozon не подключён.',
      };
    }
    if (acc.marketplace === 'ozon') {
      const res = await fetch('https://api-seller.ozon.ru/v1/warehouse/list', {
        method: 'POST',
        headers: {
          'Client-Id': acc.clientIdExt,
          'Api-Key': key,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const remote = await res.json().catch(() => ({ status: res.status }));
      const ok = res.ok;
      await this.prisma.marketplaceAccount.update({
        where: { id: acc.id },
        data: { lastSyncAt: new Date(), lastError: ok ? null : JSON.stringify(remote).slice(0, 400) },
      });
      return {
        ok,
        demo: false,
        message: ok
          ? 'Ozon ответил: ключи верные. Можно выгружать остатки и принимать заказы.'
          : 'Ozon не принял ключи. Проверьте Client ID и API-ключ в кабинете продавца.',
        remote,
      };
    }
    return { ok: true, demo: true, message: 'Для этого магазина проверка ключа в учебном режиме.' };
  }

  async pushStocks(user: Authed, accountId: string) {
    if (!user.permissions.mpStockPush) throw new ForbiddenException('Нет права выгрузки остатков');
    const acc = await this.prisma.marketplaceAccount.findFirst({ where: { id: accountId, tenantId: user.tenantId } });
    if (!acc) throw new NotFoundException('Кабинет МП');
    const bals = await this.prisma.stockBalance.groupBy({
      by: ['productId'],
      where: { tenantId: user.tenantId, clientId: acc.clientId, stockType: STOCK.GOOD },
      _sum: { qty: true },
    });
    const stocks = [];
    for (const b of bals) {
      const p = await this.prisma.product.findUnique({ where: { id: b.productId } });
      if (p) stocks.push({ offer_id: p.sku, stock: b._sum.qty || 0 });
    }
    const key = decryptSecret(acc.apiKeyEnc);
    let remote: unknown = { demo: true, skipped: !key };
    if (key && acc.marketplace === 'ozon' && acc.clientIdExt) {
      const res = await fetch('https://api-seller.ozon.ru/v2/products/stocks', {
        method: 'POST',
        headers: {
          'Client-Id': acc.clientIdExt,
          'Api-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stocks: stocks.map((s) => ({ offer_id: s.offer_id, stock: s.stock, warehouse_id: Number(acc.warehouseExt || 0) })),
        }),
      });
      remote = await res.json().catch(() => ({ status: res.status }));
    }
    if (key && acc.marketplace === 'wildberries' && acc.warehouseExt) {
      const res = await fetch(`https://marketplace-api.wildberries.ru/api/v3/stocks/${acc.warehouseExt}`, {
        method: 'PUT',
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stocks: stocks.map((s) => ({ sku: s.offer_id, amount: s.stock })) }),
      });
      remote = await res.json().catch(() => ({ status: res.status }));
    }
    if (key && acc.marketplace === 'uzum' && acc.warehouseExt) {
      const res = await fetch('https://api-seller.uzum.uz/api/seller/v1/product/stocks', {
        method: 'POST',
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stocks: stocks.map((s) => ({ productSku: s.offer_id, stock: s.stock, warehouseId: acc.warehouseExt })),
        }),
      });
      remote = await res.json().catch(() => ({ status: res.status }));
    }
    if (key && (acc.marketplace === 'yandex' || acc.marketplace === 'ym') && acc.clientIdExt) {
      const res = await fetch(`https://api.partner.market.yandex.ru/v2/campaigns/${acc.clientIdExt}/offers/stocks`, {
        method: 'PUT',
        headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skus: stocks.map((s) => ({ sku: s.offer_id, items: [{ count: s.stock, updatedAt: new Date().toISOString() }] })),
        }),
      });
      remote = await res.json().catch(() => ({ status: res.status }));
    }
    await this.prisma.marketplaceAccount.update({
      where: { id: acc.id },
      data: { lastSyncAt: new Date(), lastError: key ? null : 'demo: нет ключа, выгрузка локально зафиксирована' },
    });
    return { stocks, remote };
  }

  async createFboShipment(user: Authed, requestId: string) {
    const req = await this.getRequest(user, requestId);
    const acc = await this.prisma.marketplaceAccount.findFirst({
      where: { tenantId: user.tenantId, clientId: req.clientId || undefined, active: true },
    });
    if (!acc) throw new NotFoundException('Кабинет МП');
    const qr = `FBO-${req.number}-${Date.now().toString(36)}`;
    const sh = await this.prisma.marketplaceShipment.create({
      data: {
        tenantId: user.tenantId,
        accountId: acc.id,
        requestId,
        qr,
        status: 'created',
        type: 'fbo',
        externalId: qr,
      },
    });
    await this.prisma.request.update({ where: { id: requestId }, data: { mpShipmentId: sh.id } });
    return sh;
  }

  async inventoryApprove(user: Authed, requestId: string) {
    if (user.role !== 'Director' && user.role !== 'Owner') throw new ForbiddenException('Утверждает директор');
    const req = await this.getRequest(user, requestId);
    const payload = JSON.parse(req.payloadJson || '{}') as {
      diffs?: { productId: string; cellId: string; stockType: string; delta: number; clientId: string }[];
    };
    if (req.warehouseId) {
      for (const d of payload.diffs || []) {
        const type = d.delta > 0 ? 'surplus' : 'shortage';
        const cell = await this.prisma.cell.findFirst({ where: { id: d.cellId, tenantId: user.tenantId } });
        if (!cell) continue;
        await runStockTx(this.prisma, (tx) =>
          applyMove(tx, {
            tenantId: user.tenantId,
            type: 'inventory',
            productId: d.productId,
            clientId: d.clientId,
            qty: Math.abs(d.delta),
            warehouseId: req.warehouseId!,
            ...(d.delta > 0
              ? { to: { cellId: d.cellId, stockType: d.stockType || STOCK.GOOD } }
              : { from: { cellId: d.cellId, stockType: d.stockType || STOCK.GOOD } }),
            requestId,
            userId: user.id,
            document: type,
            allowNegative: user.permissions.stockNegative,
          }),
        );
      }
    }
    await this.prisma.request.update({ where: { id: requestId }, data: { status: 'done' } });
    return { ok: true };
  }

  async importProductsExcel(user: Authed, filePath: string, clientId: string) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheet = wb.worksheets[0];
    let n = 0;
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const sku = String(row.getCell(1).value || '').trim();
      const name = String(row.getCell(2).value || '').trim();
      if (!sku || !name) return;
      n++;
      void this.createProduct(user, {
        clientId,
        sku,
        name,
        barcode: row.getCell(3).value ? String(row.getCell(3).value) : undefined,
        weightG: Number(row.getCell(4).value || 0),
        lengthMm: Number(row.getCell(5).value || 0),
        widthMm: Number(row.getCell(6).value || 0),
        heightMm: Number(row.getCell(7).value || 0),
        requiresCis: String(row.getCell(8).value || '') === '1',
      });
    });
    return { queued: n };
  }

  async createApiKey(user: Authed, name: string, scopes: string[]) {
    if (!user.permissions.apiKeys) throw new ForbiddenException();
    const raw = 'yr_' + randomBytes(24).toString('hex');
    const rec = await this.prisma.apiKey.create({
      data: {
        tenantId: user.tenantId,
        name,
        keyHash: hashToken(raw),
        prefix: raw.slice(0, 8),
        scopes: JSON.stringify(scopes),
      },
    });
    await this.audit(user, 'create', 'ApiKey', rec.id, { name, scopes });
    return { id: rec.id, token: raw, prefix: rec.prefix };
  }

  async reports(user: Authed, kind: string) {
    const t = user.tenantId;
    if (kind === 'stock') {
      return this.prisma.stockBalance.findMany({
        where: { tenantId: t, qty: { not: 0 } },
        include: { product: true, client: true, cell: true },
      });
    }
    if (kind === 'moves') {
      return this.prisma.stockMove.findMany({ where: { tenantId: t }, orderBy: { createdAt: 'desc' }, take: 500 });
    }
    if (kind === 'sla') {
      const reqs = await this.prisma.request.findMany({ where: { tenantId: t }, include: { stages: true, type: true } });
      return reqs.map((r) => ({
        number: r.number,
        type: r.type.name,
        status: r.status,
        overdue: r.slaDueAt ? r.slaDueAt < new Date() && r.status !== 'done' : false,
      }));
    }
    if (kind === 'storage') {
      return this.prisma.storageDaily.findMany({ where: { tenantId: t }, orderBy: { date: 'desc' }, take: 90 });
    }
    if (kind === 'margin') {
      const facts = await this.prisma.serviceFact.findMany({ where: { tenantId: t } });
      const services = await this.prisma.service.findMany({ where: { tenantId: t } });
      const cost = new Map(services.map((s) => [s.code, s.costKop]));
      return facts.map((f) => ({
        ...f,
        costKop: (cost.get(f.serviceCode) || 0) * f.qty,
        marginKop: f.amountKop - (cost.get(f.serviceCode) || 0) * f.qty,
      }));
    }
    if (kind === 'debt') {
      return this.prisma.invoice.findMany({ where: { tenantId: t, status: { not: 'paid' } }, include: { client: true } });
    }
    if (kind === 'productivity') {
      return this.prisma.piecework.groupBy({
        by: ['userId', 'kind'],
        where: { tenantId: t },
        _sum: { qty: true, amountKop: true },
      });
    }
    if (kind === 'abc') {
      const moves = await this.prisma.stockMove.groupBy({
        by: ['productId'],
        where: { tenantId: t, type: { in: ['shipment', 'pick'] } },
        _sum: { qty: true },
      });
      const sorted = moves.sort((a, b) => (b._sum.qty || 0) - (a._sum.qty || 0));
      return sorted.map((m, i) => ({
        productId: m.productId,
        qty: m._sum.qty,
        class: i < sorted.length * 0.2 ? 'A' : i < sorted.length * 0.5 ? 'B' : 'C',
      }));
    }
    return [];
  }

  roleDefaults(role: string) {
    return defaultPermissions(role);
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}
