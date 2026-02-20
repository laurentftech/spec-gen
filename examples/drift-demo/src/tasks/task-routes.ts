import { Router } from 'express';
import { TaskService } from './task-service.js';
import { requireAuth } from '../auth/auth-middleware.js';

const router = Router();
const taskService = new TaskService();

router.use(requireAuth);

router.post('/', async (req, res) => {
  try {
    const task = await taskService.createTask(req.body, (req as any).userId);
    res.status(201).json(task);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const task = await taskService.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.patch('/:id', async (req, res) => {
  try {
    const task = await taskService.updateTask(req.params.id, req.body);
    res.json(task);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await taskService.deleteTask(req.params.id);
    res.status(204).send();
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const { projectId, status, assigneeId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  const tasks = await taskService.listTasks(projectId as string, {
    status: status as any,
    assigneeId: assigneeId as string,
  });
  res.json(tasks);
});

export { router as taskRouter };
