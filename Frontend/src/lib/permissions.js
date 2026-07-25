export const SERVER_PERMISSIONS = {
  owner: new Set([
    'view_server',
    'manage_server',
    'manage_channels',
    'manage_members',
    'manage_roles',
    'kick_members',
    'ban_members',
    'create_invites',
    'manage_invites',
    'transfer_ownership',
    'delete_server',
  ]),
  admin: new Set([
    'view_server',
    'manage_server',
    'manage_channels',
    'manage_members',
    'kick_members',
    'ban_members',
    'create_invites',
    'manage_invites',
  ]),
  member: new Set(['view_server']),
};

const ROLE_RANK = { member: 1, admin: 2, owner: 3 };

export function hasServerPermission(role, permission) {
  return SERVER_PERMISSIONS[role]?.has(permission) || false;
}

export function getCurrentMemberRole(members, userId) {
  return members.find((member) => member.user_id === userId)?.role || null;
}

export function canManageTargetMember(actorRole, targetRole, actorId, targetId, action) {
  if (!actorRole || !targetRole || actorId === targetId || targetRole === 'owner') return false;
  if (action === 'role') return actorRole === 'owner';
  if (action === 'kick' || action === 'ban') return ROLE_RANK[actorRole] > ROLE_RANK[targetRole];
  return false;
}
