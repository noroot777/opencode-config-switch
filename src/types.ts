export type PatchRecord = {
  file: string;
  profile: string;
  path: string;
  value: string;
};

// 新的版本记录格式 - 存储完整内容
export type VersionRecord = {
  file: string;
  profile: string;
  content: string;
};

export type FileEntry = {
  path: string;
  profiles: string[];
};

export type TreeNode = {
  key: string;
  path: string;
  type: string;
  valuePreview: string;
  children?: TreeNode[];
};
