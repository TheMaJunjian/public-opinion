export interface RegistrationInvite {
  id: string;
  hint: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  usedByName: string | null;
  revokedAt: string | null;
  status: 'available' | 'used' | 'expired' | 'revoked';
}

export interface ManagedAccount {
  id: string;
  name: string;
  founder: boolean;
  createdAt: string;
  disabledAt: string | null;
}

export interface AccessPage<T> {
  items: T[];
  nextCursor: string | null;
}
