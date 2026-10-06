import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PROCESS_PRESETS, SERVICE_PRESET } from './process-presets';
import { applyMove, STOCK } from './stock.engine';
import { encryptSecret } from './crypto-util';

const prisma = new PrismaClient();

const PRODUCTS = [
  ['DRL-18V', 'Дрель аккумуляторная 18В', 220, 80, 280, 1800, false],
  ['SHRT-BLU', 'Рубашка голубая', 320, 20, 240, 280, false],
  ['PODS-N', 'Наушники TWS', 60, 45, 60, 55, true],
  ['PAN-28', 'Сковорода 28 см', 300, 60, 300, 900, false],
  ['LID-28', 'Крышка 28 см', 300, 40, 300, 350, false],
  ['KIT-PAN', 'Комплект сковорода+крышка', 300, 100, 300, 1250, false],
  ['TEE-BLK', 'Футболка чёрная', 280, 15, 200, 180, false],
  ['MUG-W', 'Кружка белая', 90, 110, 90, 320, false],
  ['CBL-USB', 'Кабель USB-C 1м', 20, 20, 1000, 40, false],
  ['BTL-05', 'Бутылка 0.5', 70, 220, 70, 90, false],
] as const;

function moreProducts(): { sku: string; name: string; w: number; h: number; l: number; g: number; cis: boolean }[] {
  const out = [];
  for (let i = 1; i <= 40; i++) {
    out.push({
      sku: `SKU-${String(i).padStart(3, '0')}`,
      name: `Товар селлера №${i}`,
      w: 80 + (i % 7) * 10,
      h: 40 + (i % 5) * 8,
      l: 120 + (i % 9) * 12,
      g: 80 + i * 15,
      cis: i % 7 === 0,
    });
  }
  return out;
}

async function special(tenantId: string, warehouseId: string) {
  const codes: [string, string][] = [
    ['RCV', 'receiving'],
    ['SHP', 'shipping'],
    ['DEF', 'defect'],
    ['QRN', 'quarantine'],
    ['BUF', 'buffer'],
    ['TRN', 'transit'],
    ['NOM', 'virtual'],
  ];
  const map: Record<string, string> = {};
  for (const [code, type] of codes) {
    const c = await prisma.cell.create({ data: { tenantId, warehouseId, code, type, mixClients: true, mixLots: true } });
    map[code] = c.id;
  }
  return map;
}

async function main() {
  await prisma.idempotencyRecord.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.piecework.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.serviceFact.deleteMany();
  await prisma.storageDaily.deleteMany();
  await prisma.printJob.deleteMany();
  await prisma.cisCode.deleteMany();
  await prisma.marketplaceOrder.deleteMany();
  await prisma.marketplaceShipment.deleteMany();
  await prisma.marketplaceAccount.deleteMany();
  await prisma.requestExpense.deleteMany();
  await prisma.requestLine.deleteMany();
  await prisma.requestStage.deleteMany();
  await prisma.task.deleteMany();
  await prisma.request.deleteMany();
  await prisma.requestType.deleteMany();
  await prisma.stockMove.deleteMany();
  await prisma.stockBalance.deleteMany();
  await prisma.bundleItem.deleteMany();
  await prisma.barcode.deleteMany();
  await prisma.serial.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.container.deleteMany();
  await prisma.product.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.user.deleteMany();
  await prisma.client.deleteMany();
  await prisma.cell.deleteMany();
  await prisma.zone.deleteMany();
  await prisma.warehouse.deleteMany();
  await prisma.department.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.service.deleteMany();
  await prisma.consumable.deleteMany();
  await prisma.labelTemplate.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.tenant.deleteMany();

  const hash = await bcrypt.hash('Demo123!', 10);

  const platform = await prisma.tenant.create({
    data: { slug: 'platform', name: 'Ярус Платформа', mode: 'platform' },
  });
  await prisma.user.create({
    data: {
      tenantId: platform.id,
      email: 'platform@yarus.local',
      passwordHash: hash,
      fullName: 'Админ платформы',
      role: 'PlatformAdmin',
    },
  });

  const tenant = await prisma.tenant.create({
    data: {
      slug: 'severful',
      name: 'СеверФул',
      mode: 'fulfillment',
      currency: 'RUB',
      brandColor: '#1F8A70',
      featureFlags: JSON.stringify({ constructor: true, cis: true, white_label: true }),
    },
  });

  const le1 = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      name: 'ООО «СеверФул»',
      inn: '7701234567',
      country: 'RU',
      isPrimary: true,
      address: 'Московская обл., г. Подольск, ул. Складская, 1',
    },
  });
  const le2 = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      name: 'ИП Иванов А.А.',
      inn: '507800123456',
      country: 'RU',
      isPartner: true,
    },
  });

  const wh = await prisma.warehouse.create({
    data: { tenantId: tenant.id, legalEntityId: le1.id, name: 'Склад Подольск', code: 'POD', address: 'Подольск' },
  });
  const cells = await special(tenant.id, wh.id);
  const zone = await prisma.zone.create({
    data: { tenantId: tenant.id, warehouseId: wh.id, name: 'Хранение A', code: 'A', type: 'storage' },
  });
  const storageCells: string[] = [];
  for (let a = 1; a <= 2; a++) {
    for (let r = 1; r <= 2; r++) {
      for (let s = 1; s <= 2; s++) {
        for (let c = 1; c <= 4; c++) {
          const code = `A-0${a}-0${r}-0${s}-0${c}`;
          const cell = await prisma.cell.create({
            data: {
              tenantId: tenant.id,
              warehouseId: wh.id,
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
          storageCells.push(cell.id);
        }
      }
    }
  }

  for (const [code, def] of Object.entries(PROCESS_PRESETS)) {
    await prisma.requestType.create({
      data: { tenantId: tenant.id, code, name: def.name, builtIn: true, stagesJson: JSON.stringify(def.stages) },
    });
  }
  for (const s of SERVICE_PRESET) {
    await prisma.service.create({ data: { tenantId: tenant.id, ...s } });
  }
  await prisma.consumable.createMany({
    data: [
      { tenantId: tenant.id, name: 'Пакет 30×40', sku: 'BAG-3040', qty: 5000, costKop: 350 },
      { tenantId: tenant.id, name: 'Стреп-лента', sku: 'STRAP', qty: 40, costKop: 12000 },
    ],
  });
  await prisma.labelTemplate.create({
    data: {
      tenantId: tenant.id,
      name: 'КИЗ + артикул 58×40',
      widthMm: 58,
      heightMm: 40,
      kind: 'cis',
      layoutJson: JSON.stringify({
        fields: [
          { type: 'datamatrix', x: 2, y: 2, w: 18, h: 18, bind: 'cis' },
          { type: 'text', x: 22, y: 4, bind: 'sku', size: 9 },
          { type: 'text', x: 22, y: 14, bind: 'name', size: 7 },
          { type: 'code128', x: 2, y: 24, w: 54, h: 12, bind: 'barcode' },
        ],
      }),
    },
  });

  const dept = await prisma.department.create({ data: { tenantId: tenant.id, name: 'Склад' } });

  const users: Record<string, string> = {};
  for (const u of [
    ['owner@severful.local', 'Мария Власова', 'Owner'],
    ['director@severful.local', 'Игорь Директоров', 'Director'],
    ['manager@severful.local', 'Анна Менеджер', 'Manager'],
    ['lead@severful.local', 'Павел Бригадир', 'WarehouseLead'],
    ['wh@severful.local', 'Сергей Сборщик', 'Warehouse'],
    ['driver@severful.local', 'Олег Водитель', 'Driver'],
    ['acc@severful.local', 'Елена Бухгалтер', 'Accountant'],
  ] as const) {
    const rec = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: u[0],
        passwordHash: hash,
        fullName: u[1],
        role: u[2],
        departmentId: dept.id,
        birthday: u[2] === 'Warehouse' ? new Date() : undefined,
      },
    });
    users[u[2]] = rec.id;
  }

  const brand = await prisma.client.create({
    data: {
      tenantId: tenant.id,
      legalEntityId: le1.id,
      name: 'ООО «БрендСтор»',
      inn: '7711111111',
      email: 'seller@brandstor.local',
      freeStorageDays: 7,
      storageRateKop: 180,
      seeCells: true,
      canCreateBundles: true,
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'seller@brandstor.local',
      passwordHash: hash,
      fullName: 'Клиент БрендСтор',
      role: 'ClientAdmin',
      clientId: brand.id,
    },
  });
  const fashion = await prisma.client.create({
    data: {
      tenantId: tenant.id,
      legalEntityId: le2.id,
      name: 'FashionMix',
      inn: '7722222222',
      freeStorageDays: 3,
      storageRateKop: 150,
    },
  });

  const createdProducts: { id: string; sku: string }[] = [];
  for (const p of PRODUCTS) {
    const rec = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        clientId: brand.id,
        sku: p[0],
        name: p[1],
        widthMm: p[2],
        heightMm: p[3],
        lengthMm: p[4],
        weightG: p[5],
        volumeCm3: Math.round((p[2] * p[3] * p[4]) / 1000),
        requiresCis: p[6],
      },
    });
    await prisma.barcode.create({
      data: { tenantId: tenant.id, productId: rec.id, code: '200' + rec.sku.replace(/\W/g, '').padEnd(10, '0').slice(0, 10) },
    });
    createdProducts.push({ id: rec.id, sku: rec.sku });
  }
  for (const p of moreProducts()) {
    const rec = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        clientId: brand.id,
        sku: p.sku,
        name: p.name,
        widthMm: p.w,
        heightMm: p.h,
        lengthMm: p.l,
        weightG: p.g,
        volumeCm3: Math.round((p.w * p.h * p.l) / 1000),
        requiresCis: p.cis,
      },
    });
    await prisma.barcode.create({
      data: { tenantId: tenant.id, productId: rec.id, code: `21${p.sku.replace('-', '')}000`.slice(0, 13) },
    });
    createdProducts.push({ id: rec.id, sku: rec.sku });
  }

  const pan = createdProducts.find((p) => p.sku === 'PAN-28')!;
  const lid = createdProducts.find((p) => p.sku === 'LID-28')!;
  const kit = createdProducts.find((p) => p.sku === 'KIT-PAN')!;
  await prisma.bundleItem.createMany({
    data: [
      { tenantId: tenant.id, bundleId: kit.id, componentId: pan.id, qty: 1 },
      { tenantId: tenant.id, bundleId: kit.id, componentId: lid.id, qty: 1 },
    ],
  });

  let i = 0;
  for (const p of createdProducts.slice(0, 30)) {
    const cellId = storageCells[i % storageCells.length];
    await applyMove(prisma, {
      tenantId: tenant.id,
      type: 'receipt',
      productId: p.id,
      clientId: brand.id,
      qty: 40 + (i % 20),
      warehouseId: wh.id,
      to: { cellId, stockType: STOCK.GOOD },
      document: 'SEED-RCV',
    });
    await applyMove(prisma, {
      tenantId: tenant.id,
      type: 'nominal_receipt',
      productId: p.id,
      clientId: brand.id,
      qty: 40 + (i % 20),
      warehouseId: wh.id,
      to: { cellId: cells.NOM, stockType: STOCK.NOMINAL },
      document: 'SEED-NOM',
    });
    i++;
  }

  const pods = createdProducts.find((p) => p.sku === 'PODS-N')!;
  for (let n = 0; n < 980; n++) {
    await prisma.cisCode.create({
      data: {
        tenantId: tenant.id,
        productId: pods.id,
        clientId: brand.id,
        code: `01046040600000121${String(n).padStart(13, '0')}`,
        status: n < 10 ? 'printed' : 'uploaded',
        printCopies: n < 10 ? 1 : 0,
      },
    });
  }

  const acc = await prisma.marketplaceAccount.create({
    data: {
      tenantId: tenant.id,
      clientId: brand.id,
      marketplace: 'ozon',
      name: 'Ozon БрендСтор',
      apiKeyEnc: encryptSecret('demo-not-a-real-key'),
      clientIdExt: '123456',
    },
  });

  const fbsType = await prisma.requestType.findFirst({ where: { tenantId: tenant.id, code: 'fbs' } });
  const accType = await prisma.requestType.findFirst({ where: { tenantId: tenant.id, code: 'acceptance' } });
  const pickType = await prisma.requestType.findFirst({ where: { tenantId: tenant.id, code: 'pickup' } });

  if (accType) {
    const r = await prisma.request.create({
      data: {
        tenantId: tenant.id,
        number: 'Z-2026-000001',
        typeId: accType.id,
        clientId: brand.id,
        warehouseId: wh.id,
        status: 'in_progress',
        currentStageKey: 'receive',
        locked: true,
        source: 'lk',
        warningJson: '[]',
      },
    });
    await prisma.requestLine.create({
      data: { tenantId: tenant.id, requestId: r.id, productId: pods.id, sku: 'PODS-N', name: 'Наушники TWS', plannedQty: 1000 },
    });
    await prisma.requestStage.createMany({
      data: [
        { tenantId: tenant.id, requestId: r.id, key: 'approve', title: 'Согласование', status: 'done' },
        { tenantId: tenant.id, requestId: r.id, key: 'receive', title: 'Приёмка', status: 'current' },
        { tenantId: tenant.id, requestId: r.id, key: 'volume', title: 'Объём', status: 'pending' },
        { tenantId: tenant.id, requestId: r.id, key: 'putaway', title: 'Размещение', status: 'pending' },
      ],
    });
  }
  if (pickType) {
    await prisma.request.create({
      data: {
        tenantId: tenant.id,
        number: 'Z-2026-000002',
        typeId: pickType.id,
        clientId: brand.id,
        warehouseId: wh.id,
        status: 'in_progress',
        currentStageKey: 'driver',
        payloadJson: JSON.stringify({ fuelKop: 450000, entryKop: 150000 }),
        source: 'staff',
      },
    });
  }
  if (fbsType) {
    await prisma.marketplaceOrder.create({
      data: {
        tenantId: tenant.id,
        accountId: acc.id,
        externalId: '12345-0001-1',
        postingNumber: '12345-0001-1',
        status: 'awaiting_packaging',
        reserved: true,
        warehouseId: wh.id,
      },
    });
  }

  await prisma.storageDaily.create({
    data: { tenantId: tenant.id, clientId: brand.id, date: new Date().toISOString().slice(0, 10), volumeCm3: 4500000, amountKop: 810 },
  });
  await prisma.invoice.create({
    data: {
      tenantId: tenant.id,
      clientId: brand.id,
      legalEntityId: le1.id,
      number: 'СЧ-2026-00001',
      kind: 'period',
      status: 'issued',
      amountKop: 1285000,
      linesJson: JSON.stringify([
        { title: 'Хранение август', amountKop: 540000 },
        { title: 'Маркировка', amountKop: 450000 },
        { title: 'Забор', amountKop: 295000 },
      ]),
    },
  });

  await prisma.notification.create({
    data: {
      tenantId: tenant.id,
      channel: 'ui',
      event: 'seed',
      title: 'Демо-контур готов',
      body: 'СеверФул: 50+ SKU, 980 КИЗ, ячейки, заявки, счёт и FBS.',
    },
  });

  console.log('Seed OK');
  console.log('  owner@severful.local / Demo123!');
  console.log('  seller@brandstor.local / Demo123!');
  console.log('  wh@severful.local / Demo123!');
  console.log('  platform@yarus.local / Demo123!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
