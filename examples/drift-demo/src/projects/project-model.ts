export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  members: string[];
  createdAt: Date;
  updatedAt: Date;
  isArchived: boolean;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}
