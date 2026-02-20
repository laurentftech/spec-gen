import express from 'express';
import { authRouter } from './auth/auth-routes.js';
import { taskRouter } from './tasks/task-routes.js';

const app = express();
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/tasks', taskRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TaskFlow API listening on port ${PORT}`));

export { app };
