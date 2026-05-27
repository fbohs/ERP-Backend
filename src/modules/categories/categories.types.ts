export interface CategoryView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  isActive?: boolean; // only present in admin responses
  createdAt: string;
  updatedAt: string;
}

export interface CategoryActor {
  userId: string;
  tenantId: string;
}
