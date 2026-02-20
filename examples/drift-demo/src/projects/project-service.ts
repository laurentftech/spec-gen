import type { Project, CreateProjectInput } from './project-model.js';

export class ProjectService {
  async createProject(input: CreateProjectInput, userId: string): Promise<Project> {
    if (!input.name?.trim()) throw new Error('Project name is required');

    return {
      id: `proj_${Date.now()}`,
      name: input.name.trim(),
      description: input.description || '',
      ownerId: userId,
      members: [userId],
      createdAt: new Date(),
      updatedAt: new Date(),
      isArchived: false,
    };
  }

  async getProject(projectId: string): Promise<Project | null> {
    return null;
  }

  async addMember(projectId: string, userId: string): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error('Project not found');
    if (project.members.includes(userId)) throw new Error('User is already a member');
  }

  async archiveProject(projectId: string, userId: string): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error('Project not found');
    if (project.ownerId !== userId) throw new Error('Only the owner can archive a project');
  }
}
