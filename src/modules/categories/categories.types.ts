export interface CategoryView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryActor {
  userId: string;
  tenantId: string;
}
