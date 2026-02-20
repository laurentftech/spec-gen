import type { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth-service.js';

const authService = new AuthService();

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = header.slice(7);
  const payload = authService.verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  (req as any).userId = payload.userId;
  (req as any).userRole = payload.role;
  next();
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).userRole !== role) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
