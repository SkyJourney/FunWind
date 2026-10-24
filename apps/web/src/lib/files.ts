/** 文件的站内地址（/files 路由取代旧的 /attachment/**；storage_key 由内容哈希派生，见 docs/DESIGN-MODEL.md §5） */
export const fileUrl = (storageKey: string): string => `/files/${storageKey}`;
