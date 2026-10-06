export const ROLES = [
  'Owner',
  'Director',
  'Manager',
  'WarehouseLead',
  'Warehouse',
  'Driver',
  'Accountant',
  'ClientAdmin',
  'ClientUser',
  'ReadOnly',
  'API',
  'PlatformAdmin',
] as const;

export type Role = (typeof ROLES)[number];

export type PermKey =
  | 'topology'
  | 'stock'
  | 'stockNegative'
  | 'requestCreate'
  | 'requestEditAfterStart'
  | 'requestDelete'
  | 'cisPrint'
  | 'cisReprint'
  | 'mpStockPush'
  | 'tariffs'
  | 'invoices'
  | 'invoiceStorno'
  | 'othersTasks'
  | 'audit'
  | 'users'
  | 'domain'
  | 'apiKeys'
  | 'export'
  | 'seeCells'
  | 'createBundles'
  | 'clientEditRequests';

const FULL: Record<PermKey, boolean> = {
  topology: true,
  stock: true,
  stockNegative: true,
  requestCreate: true,
  requestEditAfterStart: true,
  requestDelete: true,
  cisPrint: true,
  cisReprint: true,
  mpStockPush: true,
  tariffs: true,
  invoices: true,
  invoiceStorno: true,
  othersTasks: true,
  audit: true,
  users: true,
  domain: true,
  apiKeys: true,
  export: true,
  seeCells: true,
  createBundles: true,
  clientEditRequests: true,
};

const NONE: Record<PermKey, boolean> = Object.fromEntries(
  Object.keys(FULL).map((k) => [k, false]),
) as Record<PermKey, boolean>;

export function defaultPermissions(role: string): Record<PermKey, boolean> {
  switch (role) {
    case 'Owner':
    case 'PlatformAdmin':
      return { ...FULL };
    case 'Director':
      return { ...FULL, domain: false };
    case 'Manager':
      return {
        ...NONE,
        topology: true,
        stock: true,
        requestCreate: true,
        requestEditAfterStart: true,
        cisPrint: true,
        mpStockPush: true,
        tariffs: true,
        invoices: true,
        othersTasks: true,
        export: true,
        seeCells: true,
        createBundles: true,
        clientEditRequests: true,
      };
    case 'WarehouseLead':
      return {
        ...NONE,
        topology: true,
        stock: true,
        requestCreate: true,
        cisPrint: true,
        othersTasks: true,
        seeCells: true,
      };
    case 'Warehouse':
      return { ...NONE, stock: true, cisPrint: true, seeCells: true };
    case 'Driver':
      return { ...NONE, requestCreate: false, seeCells: false };
    case 'Accountant':
      return { ...NONE, invoices: true, invoiceStorno: true, tariffs: true, export: true, audit: true };
    case 'ClientAdmin':
      return {
        ...NONE,
        requestCreate: true,
        clientEditRequests: true,
        seeCells: true,
        createBundles: true,
        export: true,
        mpStockPush: true,
      };
    case 'ClientUser':
      return { ...NONE, requestCreate: true, seeCells: false };
    case 'API':
      return { ...FULL, users: false, domain: false };
    default:
      return { ...NONE };
  }
}

export function mergePermissions(role: string, extraJson: string): Record<PermKey, boolean> {
  const base = defaultPermissions(role);
  try {
    const extra = JSON.parse(extraJson || '{}') as Partial<Record<PermKey, boolean>>;
    return { ...base, ...extra };
  } catch {
    return base;
  }
}

export function isStaff(role: string): boolean {
  return !['ClientAdmin', 'ClientUser', 'ReadOnly'].includes(role);
}

export function isClient(role: string): boolean {
  return role === 'ClientAdmin' || role === 'ClientUser';
}

export function requires2fa(role: string): boolean {
  return role === 'Owner' || role === 'Director' || role === 'PlatformAdmin';
}
