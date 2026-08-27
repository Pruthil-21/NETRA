export type UserRole = 'admin' | 'viewer' | 'operator';

export interface UserSession {
  email: string;
  department: string;
  role: UserRole;
  token?: string;
  isAuthenticated: boolean;
}

export interface LoginCredentials {
  officerId: string;
  passcode: string;
}

export interface AuthResponse {
  success: boolean;
  user?: UserSession;
  message?: string;
}