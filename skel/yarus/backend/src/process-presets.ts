export type StageDef = {
  key: string;
  title: string;
  closerRole?: string;
  requiredFields?: string[];
  autoActions?: { type: string; params?: Record<string, unknown> }[];
  slaMinutes?: number;
  clientCanEdit?: boolean;
};

export const PROCESS_PRESETS: Record<string, { name: string; stages: StageDef[] }> = {
  acceptance: {
    name: 'Приёмка',
    stages: [
      { key: 'approve', title: 'Согласование', closerRole: 'Manager', slaMinutes: 240, clientCanEdit: true },
      { key: 'receive', title: 'Приёмка', closerRole: 'Warehouse', autoActions: [{ type: 'reserve' }], slaMinutes: 480 },
      { key: 'volume', title: 'Фиксация объёма', closerRole: 'Warehouse' },
      { key: 'putaway', title: 'Размещение', closerRole: 'Warehouse' },
    ],
  },
  nominal_acceptance: {
    name: 'Номинальная приёмка',
    stages: [
      { key: 'approve', title: 'Согласование', closerRole: 'Manager', clientCanEdit: true },
      { key: 'nominal', title: 'Зачисление номинала', closerRole: 'Manager', autoActions: [{ type: 'nominal' }] },
      { key: 'layout', title: 'Отложенная раскладка', closerRole: 'Warehouse' },
    ],
  },
  fbo: {
    name: 'FBO-поставка',
    stages: [
      { key: 'pick', title: 'Подбор', closerRole: 'Warehouse' },
      { key: 'box', title: 'Короба и паллетный лист', closerRole: 'Warehouse' },
      { key: 'mp', title: 'Создание поставки в МП', closerRole: 'Manager', autoActions: [{ type: 'mp_api' }] },
      { key: 'ship', title: 'Отгрузка', closerRole: 'Warehouse' },
    ],
  },
  fbs: {
    name: 'FBS-заказ',
    stages: [
      { key: 'reserve', title: 'Резерв', autoActions: [{ type: 'reserve' }] },
      { key: 'pick', title: 'Сборка', closerRole: 'Warehouse' },
      { key: 'pack', title: 'Упаковка', closerRole: 'Warehouse' },
      { key: 'ship', title: 'Отгрузка на ПВЗ', closerRole: 'Warehouse' },
    ],
  },
  pickup: {
    name: 'Забор',
    stages: [
      { key: 'approve', title: 'Согласование перечня работ', closerRole: 'Manager', clientCanEdit: true },
      { key: 'volume', title: 'Объём груза', closerRole: 'Manager' },
      { key: 'logistics', title: 'Логистика', closerRole: 'Manager' },
      { key: 'driver', title: 'Назначение водителя', closerRole: 'Manager', autoActions: [{ type: 'assign' }] },
      { key: 'pickup', title: 'Забор груза', closerRole: 'Driver' },
      { key: 'receive', title: 'Приёмка на складе', closerRole: 'Warehouse' },
    ],
  },
  buyer: {
    name: 'Байер',
    stages: [
      { key: 'brief', title: 'ТЗ', clientCanEdit: true },
      { key: 'buy', title: 'Закупка', closerRole: 'Manager' },
      { key: 'receive', title: 'Приёмка', closerRole: 'Warehouse' },
    ],
  },
  return: {
    name: 'Возврат',
    stages: [
      { key: 'intake', title: 'Приём возврата', closerRole: 'Warehouse' },
      { key: 'decision', title: 'Решение: годный / брак / утиль', closerRole: 'Manager' },
      { key: 'place', title: 'Размещение', closerRole: 'Warehouse' },
    ],
  },
  inventory: {
    name: 'Инвентаризация',
    stages: [
      { key: 'count', title: 'Пересчёт ТСД', closerRole: 'Warehouse' },
      { key: 'diff', title: 'План-факт', closerRole: 'WarehouseLead' },
      { key: 'approve', title: 'Утверждение директором', closerRole: 'Director' },
    ],
  },
  content: {
    name: 'Контент',
    stages: [
      { key: 'brief', title: 'ТЗ', clientCanEdit: true },
      { key: 'photo', title: 'Фотоотчёт', closerRole: 'Warehouse', autoActions: [{ type: 'photo_report' }] },
      { key: 'done', title: 'Сдача', closerRole: 'Manager' },
    ],
  },
};

export const SERVICE_PRESET = [
  { code: 'recount', name: 'Пересчёт', unit: 'pcs', priceKop: 300, costKop: 80 },
  { code: 'sort', name: 'Сортировка', unit: 'pcs', priceKop: 250, costKop: 70 },
  { code: 'prep', name: 'Подготовка', unit: 'pcs', priceKop: 400, costKop: 100 },
  { code: 'mark', name: 'Маркировка', unit: 'pcs', priceKop: 500, costKop: 120 },
  { code: 'double_mark', name: 'Двойная маркировка', unit: 'pcs', priceKop: 800, costKop: 200 },
  { code: 'cis', name: 'КИЗ', unit: 'pcs', priceKop: 350, costKop: 90 },
  { code: 'defect_check', name: 'Брак-осмотр', unit: 'pcs', priceKop: 600, costKop: 150 },
  { code: 'tag', name: 'Бирка', unit: 'pcs', priceKop: 200, costKop: 40 },
  { code: 'bag', name: 'Пакет', unit: 'pcs', priceKop: 150, costKop: 50 },
  { code: 'scan_dm', name: 'Скан DataMatrix', unit: 'pcs', priceKop: 100, costKop: 20 },
  { code: 'pickup', name: 'Забор', unit: 'trip', priceKop: 250000, costKop: 80000 },
  { code: 'prr', name: 'ПРР', unit: 'hour', priceKop: 150000, costKop: 60000 },
  { code: 'storage', name: 'Хранение', unit: 'm3_day', priceKop: 150, costKop: 40 },
];
