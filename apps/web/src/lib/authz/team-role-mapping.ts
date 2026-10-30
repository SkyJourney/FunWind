export const TEAM_ROLE_BADGE_KEYS = {
  "team-subtitle": "team-subtitle",
  "team-tech": "team-tech",
  "team-planning": "team-planning",
  "team-resource": "team-resource",
  "team-art": "team-art",
  "team-intern": "team-intern",
} as const;

export type TeamMembershipRoleKey = keyof typeof TEAM_ROLE_BADGE_KEYS;

export const isTeamMembershipRole = (roleKey: string): roleKey is TeamMembershipRoleKey =>
  Object.hasOwn(TEAM_ROLE_BADGE_KEYS, roleKey);

export const teamBadgeKeyForRole = (roleKey: TeamMembershipRoleKey): string =>
  TEAM_ROLE_BADGE_KEYS[roleKey];
