import type { Task, CreateTaskInput, UpdateTaskInput, TaskStatus } from './task-model.js';

export class TaskService {
  async createTask(input: CreateTaskInput, userId: string): Promise<Task> {
    if (!input.title?.trim()) throw new Error('Task title is required');
    if (!input.projectId) throw new Error('Project ID is required');

    return {
      id: `task_${Date.now()}`,
      title: input.title.trim(),
      description: input.description || '',
      status: 'todo',
      priority: input.priority || 'medium',
      assigneeId: input.assigneeId || null,
      projectId: input.projectId,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      tags: input.tags || [],
    };
  }

  async getTask(taskId: string): Promise<Task | null> {
    return null; // DB lookup
  }

  async updateTask(taskId: string, input: UpdateTaskInput): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    // Validate status transitions
    if (input.status) {
      this.validateStatusTransition(task.status, input.status);
    }

    return { ...task, ...input, updatedAt: new Date() } as Task;
  }

  async deleteTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
  }

  async listTasks(projectId: string, filters?: { status?: TaskStatus; assigneeId?: string }): Promise<Task[]> {
    return []; // DB query with filters
  }

  private validateStatusTransition(current: TaskStatus, next: TaskStatus): void {
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      'todo': ['in_progress', 'cancelled'],
      'in_progress': ['done', 'todo', 'cancelled'],
      'done': ['todo'],
      'cancelled': ['todo'],
    };
    if (!allowed[current]?.includes(next)) {
      throw new Error(`Cannot transition from ${current} to ${next}`);
    }
  }
}
