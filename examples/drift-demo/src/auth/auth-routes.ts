import { Router } from 'express';
import { AuthService } from './auth-service.js';

const router = Router();
const authService = new AuthService();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await authService.login(email, password);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    const result = await authService.register(email, password, name);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

export { router as authRouter };
