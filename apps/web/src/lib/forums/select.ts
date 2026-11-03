import { forums } from "@funwind/db";

/** 版块树节点的唯一投影；只描述 schema 列，不加载树或执行数据库 IO。 */
export const forumSelectCols = {
  id: forums.id,
  parentId: forums.parentId,
  path: forums.path,
  depth: forums.depth,
  kind: forums.kind,
  name: forums.name,
  description: forums.description,
  iconKey: forums.iconKey,
  sortOrder: forums.sortOrder,
  readPolicy: forums.readPolicy,
  writePolicy: forums.writePolicy,
  reviewPolicy: forums.reviewPolicy,
  isListed: forums.isListed,
  isArchived: forums.isArchived,
};
