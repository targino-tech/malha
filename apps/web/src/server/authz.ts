import { HttpError } from './http';

export const ROLES = ['admin', 'ti', 'tecnico', 'diretoria', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const roleLabels: Record<Role, string> = {
  admin: 'Admin do grupo',
  ti: 'TI do grupo',
  tecnico: 'Técnico de fazenda',
  diretoria: 'Diretoria',
  auditor: 'Auditor',
};

const grants = {
  'inventory.write': ['admin', 'ti', 'tecnico'],
  'occurrences.acknowledge': ['admin', 'ti', 'tecnico'],
  'integrations.read': ['admin', 'ti', 'tecnico'],
  'collectors.enroll': ['admin'],
  'farms.manage': ['admin'],
  'members.manage': ['admin'],
  'baseline.manage': ['admin'],
  'exports.run': ['admin', 'ti', 'auditor'],
  'monitoring.export': ['admin', 'ti'],
  'monitoring.apply': ['admin'],
  'audit.read': ['admin', 'auditor'],
  'alerts.manage': ['admin', 'ti'],
} satisfies Record<string, Role[]>;

export type Permission = keyof typeof grants;

/** Escopo resolvido do usuário: `farmIds` nulo significa todas as fazendas do grupo. */
export type Scope = { role: Role; farmIds: string[] | null };

export function can(user: Scope, permission: Permission) {
  return (grants[permission] as Role[]).includes(user.role);
}

export function requirePermission(user: Scope, permission: Permission) {
  if (!can(user, permission)) throw new HttpError(403, 'O seu perfil não permite esta operação.');
}

export function farmAllowed(user: Scope, farmId: string) {
  return user.farmIds === null || user.farmIds.includes(farmId);
}

/** Fazendas fora do escopo respondem como inexistentes, sem revelar que existem. */
export function requireFarm(user: Scope, farmId: string) {
  if (!farmAllowed(user, farmId)) throw new HttpError(404, 'Fazenda indisponível.');
}

export function permissionsOf(user: Scope) {
  return Object.fromEntries((Object.keys(grants) as Permission[]).map((key) => [key, can(user, key)])) as Record<Permission, boolean>;
}

/** Admin vê o grupo inteiro; técnico só vê fazendas atribuídas; os demais podem ser restritos por atribuição. */
export function resolveFarmScope(role: Role, assigned: string[] | null): string[] | null {
  if (role === 'admin') return null;
  if (role === 'tecnico') return assigned ?? [];
  return assigned?.length ? assigned : null;
}
