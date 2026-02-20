import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface AuthResult {
  token: string;
  expiresIn: number;
  userId: string;
}

export class AuthService {
  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.findUserByEmail(email);
    if (!user) throw new Error('User not found');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new Error('Invalid credentials');

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    return { token, expiresIn: 86400, userId: user.id };
  }

  async register(email: string, password: string, name: string): Promise<AuthResult> {
    const existing = await this.findUserByEmail(email);
    if (existing) throw new Error('Email already registered');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.createUser({ email, passwordHash, name, role: 'user' });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    return { token, expiresIn: 86400, userId: user.id };
  }

  verifyToken(token: string): { userId: string; role: string } | null {
    try {
      return jwt.verify(token, JWT_SECRET) as { userId: string; role: string };
    } catch {
      return null;
    }
  }

  private async findUserByEmail(email: string) { return null as any; }
  private async createUser(data: any) { return { id: 'new-id', ...data }; }
}
